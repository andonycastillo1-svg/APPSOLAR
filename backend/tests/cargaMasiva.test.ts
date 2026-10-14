import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { cerrarTodo, limpiarDatos, prepararBaseDeDatos } from './utils/entorno';
import { getPool, query } from '../src/db/pool';
import { generarPlantillaCargaMasiva, generarSql, leerCargaMasiva, literal } from '../src/db/cargaMasiva';

/** Arma un libro con los mismos encabezados de la plantilla oficial. */
async function libro(hojas: Record<string, Array<Array<string | number | null>>>): Promise<Buffer> {
  const plantilla = new ExcelJS.Workbook();
  await plantilla.xlsx.load((await generarPlantillaCargaMasiva()) as unknown as ArrayBuffer);
  const nuevo = new ExcelJS.Workbook();
  for (const nombre of ['Clientes', 'Proyectos', 'Grupos', 'Inversores']) {
    const origen = plantilla.getWorksheet(nombre)!;
    const ws = nuevo.addWorksheet(nombre);
    const cabecera = (origen.getRow(1).values as unknown[]).slice(1);
    ws.addRow(cabecera as string[]);
    (hojas[nombre] ?? []).forEach((f) => ws.addRow(f));
  }
  return Buffer.from(await nuevo.xlsx.writeBuffer());
}

const BASE = {
  Clientes: [['Solar Norte, S.A.', '1234567-8', 'Escuintla', 'Ana', '5555-1111', 'ANA@norte.com', 'SI']],
  Proyectos: [
    ['1234567-8', "Planta O'Brien Norte", 'Escuintla', 'EDS', 'DISTRIBUIDORA', 'BTDA', null, 1.25, 250.5, '2025-03-01', 'Con comilla y \\ barra'],
  ],
  Grupos: [["Planta O'Brien Norte", 'Grupo 1', 2, 'SI', 40, 250.5, null, null]],
  Inversores: [
    ["Planta O'Brien Norte", 'Grupo 1', 'Huawei', 'SUN2000', 'HUAWEI_API', 'HV001', null, 100, 'ACTIVO', null],
    ["Planta O'Brien Norte", 'Grupo 1', 'Fronius', 'Symo', 'MANUAL', null, null, 80, 'ACTIVO', null],
  ],
};

async function ejecutarSql(sql: string): Promise<void> {
  const conn = await getPool().getConnection();
  try {
    const sentencias = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of sentencias) await conn.query(s);
  } finally {
    conn.release();
  }
}

describe('Carga masiva de clientes, proyectos, grupos e inversores', () => {
  beforeAll(async () => {
    await prepararBaseDeDatos();
  }, 120000);
  beforeEach(async () => {
    await limpiarDatos();
    // El inversor HUAWEI_API debe enlazarse a la integracion existente.
    await getPool().query(
      `INSERT INTO apis_fabricante (marca, nombre, endpoint, modo, estado, timeout_s, max_reintentos)
       VALUES ('HUAWEI', 'Huawei Pruebas', 'http://127.0.0.1:9/thirdData', 'REAL', 'ACTIVA', 10, 1)`,
    );
  });
  afterAll(async () => {
    await cerrarTodo();
  });

  it('la plantilla trae las cuatro hojas y las instrucciones', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await generarPlantillaCargaMasiva()) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Instrucciones', 'Clientes', 'Proyectos', 'Grupos', 'Inversores']);
  });

  it('las filas de ejemplo de la plantilla se ignoran', async () => {
    const lectura = await leerCargaMasiva(await generarPlantillaCargaMasiva());
    expect(lectura.datos.clientes).toHaveLength(0);
    expect(lectura.errores.map((e) => e.mensaje).join(' ')).toContain('no tiene filas para cargar');
  });

  it('carga la estructura completa, enlaza el inversor Huawei y es idempotente', async () => {
    const lectura = await leerCargaMasiva(await libro(BASE));
    expect(lectura.errores).toEqual([]);
    const sql = generarSql(lectura.datos);

    await ejecutarSql(sql);
    await ejecutarSql(sql); // repetirlo no duplica

    expect((await query<{ n: number }>('SELECT COUNT(*) AS n FROM clientes'))[0].n).toBe(1);
    const proyecto = (await query<{ nombre: string; tipo_proyecto: string; id_cliente: number }>(
      'SELECT nombre, tipo_proyecto, id_cliente FROM proyectos',
    ))[0];
    expect(proyecto.nombre).toBe("Planta O'Brien Norte");
    expect(proyecto.tipo_proyecto).toBe('EDS');
    const cliente = (await query<{ email: string }>('SELECT email FROM clientes'))[0];
    expect(cliente.email).toBe('ana@norte.com');

    const grupos = await query<{ tiene_banco_baterias: number; capacidad_baterias_kwh: number }>('SELECT * FROM grupos');
    expect(grupos).toHaveLength(1);
    expect(Number(grupos[0].tiene_banco_baterias)).toBe(1);

    const inversores = await query<{ serial_externo: string | null; id_api: number | null; tipo_conexion: string }>(
      'SELECT serial_externo, id_api, tipo_conexion FROM inversores ORDER BY id_inversor',
    );
    expect(inversores).toHaveLength(2);
    expect(inversores[0].serial_externo).toBe('HV001');
    expect(inversores[0].id_api).not.toBeNull();
    expect(inversores[1].id_api).toBeNull();
  });

  it('al repetir la carga con datos cambiados actualiza en lugar de duplicar', async () => {
    await ejecutarSql(generarSql((await leerCargaMasiva(await libro(BASE))).datos));
    const cambiado = structuredClone(BASE);
    cambiado.Inversores[0][7] = 125;
    cambiado.Grupos[0][2] = 3;
    await ejecutarSql(generarSql((await leerCargaMasiva(await libro(cambiado))).datos));
    const inv = (await query<{ capacidad_kwp: number }>("SELECT capacidad_kwp FROM inversores WHERE serial_externo = 'HV001'"))[0];
    expect(Number(inv.capacidad_kwp)).toBe(125);
    expect((await query<{ n: number }>('SELECT COUNT(*) AS n FROM inversores'))[0].n).toBe(2);
  });

  describe('validaciones (con hoja y fila exactas)', () => {
    const conCambio = async (mutar: (b: typeof BASE) => void) => {
      const b = structuredClone(BASE);
      mutar(b);
      return leerCargaMasiva(await libro(b));
    };
    const mensajes = (r: Awaited<ReturnType<typeof leerCargaMasiva>>) => r.errores.map((e) => `${e.hoja}:${e.fila} ${e.mensaje}`);

    it('proyecto con un NIT de cliente que no existe', async () => {
      const r = await conCambio((b) => (b.Proyectos[0][0] = '999999-9'));
      expect(mensajes(r).join('\n')).toMatch(/Proyectos:2 .*no existe en la hoja Clientes/);
    });
    it('grupo de un proyecto inexistente', async () => {
      const r = await conCambio((b) => (b.Grupos[0][0] = 'Otra planta'));
      expect(mensajes(r).join('\n')).toMatch(/Grupos:2 .*no existe en la hoja Proyectos/);
    });
    it('inversor en un grupo que no existe', async () => {
      const r = await conCambio((b) => (b.Inversores[0][1] = 'Grupo X'));
      expect(mensajes(r).join('\n')).toMatch(/Inversores:2 .*no existe en el proyecto/);
    });
    it('inversor HUAWEI_API sin numero de serie', async () => {
      const r = await conCambio((b) => (b.Inversores[0][5] = null));
      expect(mensajes(r).join('\n')).toMatch(/Inversores:2 .*necesita su n/);
    });
    it('modalidad, conexion y estado invalidos', async () => {
      const r = await conCambio((b) => {
        b.Proyectos[0][3] = 'XYZ';
        b.Inversores[1][4] = 'WIFI';
        b.Inversores[0][8] = 'ROTO';
      });
      const texto = mensajes(r).join('\n');
      expect(texto).toMatch(/modalidad debe ser PPA, EPC o EDS/);
      expect(texto).toMatch(/conexi.n debe ser MANUAL o HUAWEI_API/);
      expect(texto).toMatch(/estado debe ser ACTIVO/);
    });
    it('NIT repetido, serie repetida y capacidad de baterias sin banco', async () => {
      const r = await conCambio((b) => {
        b.Clientes.push(['Otro', '1234567-8', null, null, null, null, 'SI']);
        b.Inversores[1][5] = 'HV001';
        b.Grupos[0][3] = 'NO';
      });
      const texto = mensajes(r).join('\n');
      expect(texto).toMatch(/NIT 1234567-8 est. repetido/);
      expect(texto).toMatch(/serie HV001 est. repetida/);
      expect(texto).toMatch(/capacidad de bater.as/);
    });
    it('numeros y fechas mal escritos', async () => {
      const r = await conCambio((b) => {
        b.Proyectos[0][8] = 'mucho';
        b.Proyectos[0][9] = '31/02/2025';
      });
      const texto = mensajes(r).join('\n');
      expect(texto).toMatch(/Potencia instalada debe ser un n.mero/);
      expect(texto).toMatch(/fecha de inicio debe tener formato/);
    });
    it('avisa (sin bloquear) cuando los inversores declarados no coinciden', async () => {
      const r = await conCambio((b) => (b.Grupos[0][2] = 5));
      expect(r.errores).toEqual([]);
      expect(r.avisos.map((a) => a.mensaje).join(' ')).toContain('declara 5 inversor(es)');
    });
  });

  describe('suministradora y tipo de tarifa', () => {
    const conCambio = async (mutar: (b: typeof BASE) => void) => {
      const b = structuredClone(BASE);
      mutar(b);
      return leerCargaMasiva(await libro(b));
    };
    const texto = (r: Awaited<ReturnType<typeof leerCargaMasiva>>) =>
      r.errores.map((e) => `${e.hoja}:${e.fila} ${e.mensaje}`).join('\n');

    it('PPA exige distribuidora y EPC comercializadora', async () => {
      const ppa = await conCambio((b) => {
        b.Proyectos[0][3] = 'PPA';
        b.Proyectos[0][4] = 'COMERCIALIZADORA';
        b.Proyectos[0][6] = 0.9;
        b.Proyectos[0][7] = null;
      });
      expect(texto(ppa)).toMatch(/PPA trabaja siempre con DISTRIBUIDORA/);
      const epc = await conCambio((b) => (b.Proyectos[0][3] = 'EPC'));
      expect(texto(epc)).toMatch(/EPC trabaja siempre con COMERCIALIZADORA/);
    });

    it('la comercializadora necesita valor pactado y la distribuidora no lo admite', async () => {
      const sinValor = await conCambio((b) => {
        b.Proyectos[0][4] = 'COMERCIALIZADORA';
        b.Proyectos[0][7] = null;
      });
      expect(texto(sinValor)).toMatch(/necesita su valor pactado/);
      const conValor = await conCambio((b) => (b.Proyectos[0][6] = 0.9));
      expect(texto(conValor)).toMatch(/solo aplica a COMERCIALIZADORA/);
    });

    it('rechaza una sigla de tarifa que no esta en el catalogo', async () => {
      const r = await conCambio((b) => (b.Proyectos[0][5] = 'ZZZ'));
      expect(texto(r)).toMatch(/tipo de tarifa debe ser una sigla del cat/);
    });

    it('carga suministradora, tipo de tarifa, valor pactado y tarifa del trimestre en curso', async () => {
      await ejecutarSql(generarSql((await leerCargaMasiva(await libro(BASE))).datos));
      const p = (await query<{ suministradora: string; sigla: string; valor_pactado_kwh: number | null }>(
        `SELECT p.suministradora, t.sigla, p.valor_pactado_kwh
           FROM proyectos p JOIN tipos_tarifa t ON t.id_tipo_tarifa = p.id_tipo_tarifa`,
      ))[0];
      expect(p.suministradora).toBe('DISTRIBUIDORA');
      expect(p.sigla).toBe('BTDA');
      expect(p.valor_pactado_kwh).toBeNull();
      const tarifa = (await query<{ n: number; costo_kwh: number }>(
        'SELECT COUNT(*) AS n, MAX(costo_kwh) AS costo_kwh FROM tarifas_kwh',
      ))[0];
      expect(Number(tarifa.n)).toBe(1);
      expect(Number(tarifa.costo_kwh)).toBe(1.25);

      // Repetir la carga no duplica la tarifa del trimestre.
      await ejecutarSql(generarSql((await leerCargaMasiva(await libro(BASE))).datos));
      expect(Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM tarifas_kwh'))[0].n)).toBe(1);
    });

    it('una comercializadora guarda su valor pactado', async () => {
      const b = structuredClone(BASE);
      b.Proyectos[0][3] = 'EPC';
      b.Proyectos[0][4] = 'COMERCIALIZADORA';
      b.Proyectos[0][6] = 0.95;
      b.Proyectos[0][7] = null;
      const lectura = await leerCargaMasiva(await libro(b));
      expect(lectura.errores).toEqual([]);
      await ejecutarSql(generarSql(lectura.datos));
      const p = (await query<{ suministradora: string; valor_pactado_kwh: number }>(
        'SELECT suministradora, valor_pactado_kwh FROM proyectos',
      ))[0];
      expect(p.suministradora).toBe('COMERCIALIZADORA');
      expect(Number(p.valor_pactado_kwh)).toBe(0.95);
      expect(Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM tarifas_kwh'))[0].n)).toBe(0);
    });
  });

  it('escapa comillas y barras invertidas: ningun texto puede romper el SQL', () => {
    expect(literal("O'Brien")).toBe("'O''Brien'");
    expect(literal('a\\b')).toBe("'a\\\\b'");
    expect(literal("x'); DROP TABLE clientes; --")).toBe("'x''); DROP TABLE clientes; --'");
    expect(literal('linea1\nlinea2')).toBe("'linea1 linea2'");
    expect(literal(null)).toBe('NULL');
    expect(literal(true)).toBe('1');
  });
});
