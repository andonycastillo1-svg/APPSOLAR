import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import request from 'supertest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearGrupo,
  crearUsuario,
  filasProduccion,
  iniciarSesion,
  levantarPythonSimulado,
  limpiarDatos,
  obtenerApp,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type ComportamientoPython,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { env } from '../src/config/env';
import { execute, queryOne } from '../src/db/pool';

/**
 * 1. El mes no se descuadra al sincronizar varias veces ni al mezclar lecturas
 *    diarias parciales con la cifra mensual.
 * 2. Boton "Sincronizar ahora": sin fechas, para los tres roles.
 * 3. Plantilla de planta completa (mes, grupo, inversor).
 */
describe('Sincronizacion al momento y plantilla de planta completa', () => {
  let admin: Sesion;
  let operativo: Sesion;
  let gerencial: Sesion;
  let datos: DatosBase;
  let cerrarStub: () => Promise<void>;
  let comportamiento: ComportamientoPython = { tipo: 'EXITO', registros: [] };
  const urlOriginal = env.python.url;
  const timeoutOriginal = env.python.timeoutMs;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('sa.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('sa.oper@retse.com.gt', 'OPERATIVO');
    await crearUsuario('sa.ger@retse.com.gt', 'GERENCIAL');
    admin = await iniciarSesion('sa.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('sa.oper@retse.com.gt', PASSWORD_PRUEBAS);
    gerencial = await iniciarSesion('sa.ger@retse.com.gt', PASSWORD_PRUEBAS);
    const stub = await levantarPythonSimulado(() => comportamiento);
    cerrarStub = stub.cerrar;
    env.python.url = stub.url;
    env.python.timeoutMs = 2000;
  }, 120000);

  beforeEach(async () => {
    await limpiarDatos();
    datos = await crearDatosBase();
    comportamiento = { tipo: 'EXITO', registros: [] };
  });

  afterAll(async () => {
    env.python.url = urlOriginal;
    env.python.timeoutMs = timeoutOriginal;
    await cerrarStub();
    await cerrarTodo();
  });

  async function totalMes(desde: string, hasta: string): Promise<number> {
    const r = await comoUsuario(admin)
      .get(`/api/production/summary?desde=${desde}&hasta=${hasta}&id_proyecto=${datos.idProyecto}`)
      .expect(200);
    return Number(r.body.datos.kwh);
  }

  // -------------------------------------------------------------------------
  // 1. El mes no se descuadra
  // -------------------------------------------------------------------------
  describe('totales mensuales consistentes', () => {
    async function insertar(
      fecha: string,
      granularidad: 'DIARIA' | 'MENSUAL',
      kwh: number,
      idInversor = datos.idInversorHuawei,
    ) {
      await execute(
        `INSERT INTO produccion (id_proyecto, id_inversor, id_grupo, nivel_detalle, fecha, anio, mes,
                                 granularidad, kwh, origen, secuencia)
         VALUES (?, ?, ?, 'POR_INVERSOR', ?, ?, ?, ?, ?, 'HUAWEI_API', 0)`,
        [datos.idProyecto, idInversor, datos.idGrupo, fecha, Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)), granularidad, kwh],
      );
    }

    it('con pocos dias diarios y la cifra mensual, el mes usa la mensual (no solo esos dias)', async () => {
      await insertar('2025-09-01', 'MENSUAL', 3000);
      await insertar('2025-09-28', 'DIARIA', 100);
      await insertar('2025-09-29', 'DIARIA', 110);
      await insertar('2025-09-30', 'DIARIA', 90);
      expect(await totalMes('2025-09-01', '2025-09-30')).toBe(3000);
    });

    it('con el mes completo en diario, gana la diaria y no se suma la mensual', async () => {
      await insertar('2025-09-01', 'MENSUAL', 3000);
      for (let d = 1; d <= 30; d += 1) await insertar(`2025-09-${String(d).padStart(2, '0')}`, 'DIARIA', 100);
      expect(await totalMes('2025-09-01', '2025-09-30')).toBe(3000);
    });

    it('si solo hay lecturas diarias parciales (sin mensual) se suman tal cual', async () => {
      await insertar('2025-09-28', 'DIARIA', 100);
      await insertar('2025-09-29', 'DIARIA', 110);
      expect(await totalMes('2025-09-01', '2025-09-30')).toBe(210);
    });

    it('sincronizar la misma data varias veces no cambia el total del mes', async () => {
      comportamiento = {
        tipo: 'EXITO',
        registros: [
          { serial: 'SN-HW0', fecha: '2025-05-01', kwh: 100 },
          { serial: 'SN-HW0', fecha: '2025-05-02', kwh: 120 },
        ],
      };
      const enviar = () =>
        comoUsuario(operativo)
          .post('/api/integrations/huawei/sync')
          .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-02', granularidad: 'DIARIA' })
          .expect(200);

      await enviar();
      const primero = await totalMes('2025-05-01', '2025-05-31');
      await enviar();
      await enviar();
      expect(await totalMes('2025-05-01', '2025-05-31')).toBe(primero);
      expect(primero).toBe(220);
      expect((await filasProduccion(datos.idProyecto)).length).toBe(2);
    });

    it('la sincronizacion diaria abarca el mes completo aunque se pida un rango corto', async () => {
      comportamiento = { tipo: 'EXITO', registros: [{ serial: 'SN-HW0', fecha: '2025-05-02', kwh: 120 }] };
      await comoUsuario(operativo)
        .post('/api/integrations/huawei/sync')
        .send({ id_api: datos.idApi, desde: '2025-05-10', hasta: '2025-05-12', granularidad: 'DIARIA' })
        .expect(200);
      const sync = await queryOne<{ rango_desde: string; rango_hasta: string }>(
        'SELECT rango_desde, rango_hasta FROM sincronizaciones ORDER BY id_sync DESC LIMIT 1',
      );
      expect(String(sync!.rango_desde).slice(0, 10)).toBe('2025-05-01');
      expect(String(sync!.rango_hasta).slice(0, 10)).toBe('2025-05-31');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Boton "Sincronizar ahora"
  // -------------------------------------------------------------------------
  describe('boton Sincronizar ahora', () => {
    it.each([
      ['administrativo', () => admin],
      ['operativo', () => operativo],
      ['gerencial', () => gerencial],
    ])('el usuario %s puede ejecutarlo sin enviar fechas', async (_nombre, sesion) => {
      const hoy = new Date().toISOString().slice(0, 10);
      comportamiento = { tipo: 'EXITO', registros: [{ serial: 'SN-HW0', fecha: hoy, kwh: 50 }] };
      const r = await comoUsuario(sesion()).post('/api/integrations/huawei/sync-now').send({}).expect(200);
      expect(r.body.datos.estado).toMatch(/COMPLETADA/);
      expect(r.body.datos.hasta).toBe(hoy);
      expect(r.body.datos.mensaje).toContain('Sincronizacion al momento');
    });

    it('repetirlo no suma de nuevo la produccion', async () => {
      const hoy = new Date().toISOString().slice(0, 10);
      comportamiento = { tipo: 'EXITO', registros: [{ serial: 'SN-HW0', fecha: hoy, kwh: 50 }] };
      await comoUsuario(operativo).post('/api/integrations/huawei/sync-now').send({}).expect(200);
      const antes = (await filasProduccion(datos.idProyecto)).length;
      await comoUsuario(operativo).post('/api/integrations/huawei/sync-now').send({}).expect(200);
      expect((await filasProduccion(datos.idProyecto)).length).toBe(antes);
    });

    it('valida los inversores recien agregados: los enlaza, carga su historial y los reporta', async () => {
      // Inversor Huawei de un proyecto nuevo, agregado sin vincular a la integracion.
      const nuevoInv = await execute(
        `INSERT INTO inversores (id_proyecto, id_grupo, marca, modelo, tipo_conexion, serial_externo, estado, id_api, activo)
         VALUES (?, ?, 'Huawei', 'SUN2000', 'HUAWEI_API', 'SN-NUEVO', 'ACTIVO', NULL, 1)`,
        [datos.idProyecto, datos.idGrupo],
      );
      const hoy = new Date().toISOString().slice(0, 10);
      comportamiento = {
        tipo: 'EXITO',
        registros: [
          { serial: 'SN-HW0', fecha: hoy, kwh: 50 },
          { serial: 'SN-NUEVO', fecha: hoy, kwh: 70 },
        ],
      };

      const r = await comoUsuario(operativo).post('/api/integrations/huawei/sync-now').send({}).expect(200);

      const inv = await queryOne<{ id_api: number | null }>('SELECT id_api FROM inversores WHERE id_inversor = ?', [
        nuevoInv.insertId,
      ]);
      expect(inv!.id_api).toBe(datos.idApi);
      expect(r.body.datos.proyectosNuevos).toContain('Planta Pruebas');
      expect(r.body.datos.inversoresSinDatos).toEqual([]);
      expect(r.body.datos.mensaje).toContain('validado');
      const filas = await queryOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM produccion WHERE id_inversor = ? AND origen = 'HUAWEI_API'",
        [nuevoInv.insertId],
      );
      expect(Number(filas!.total)).toBeGreaterThan(0);
    });

    it('avisa de los inversores que siguen sin ningun dato de Huawei', async () => {
      await execute(
        `INSERT INTO inversores (id_proyecto, id_grupo, marca, modelo, tipo_conexion, serial_externo, estado, id_api, activo)
         VALUES (?, ?, 'Huawei', 'SUN2000', 'HUAWEI_API', 'SN-SIN-DATOS', 'ACTIVO', ?, 1)`,
        [datos.idProyecto, datos.idGrupo, datos.idApi],
      );
      const hoy = new Date().toISOString().slice(0, 10);
      comportamiento = { tipo: 'EXITO', registros: [{ serial: 'SN-HW0', fecha: hoy, kwh: 50 }] };

      const r = await comoUsuario(operativo).post('/api/integrations/huawei/sync-now').send({}).expect(200);
      expect(r.body.datos.estado).toBe('COMPLETADA_CON_ERRORES');
      expect(r.body.datos.inversoresSinDatos.join(' ')).toContain('SN-SIN-DATOS');
      expect(r.body.datos.advertencias.join(' ')).toContain('SN-SIN-DATOS');
    });

    it('la segunda pulsacion no repite la consulta mensual ya verificada (ahorra el cupo de Huawei)', async () => {
      const hoy = new Date().toISOString().slice(0, 10);
      comportamiento = { tipo: 'EXITO', registros: [{ serial: 'SN-HW0', fecha: hoy, kwh: 50 }] };
      const primera = await comoUsuario(operativo).post('/api/integrations/huawei/sync-now').send({}).expect(200);
      expect(primera.body.datos.consultado.some((c: string) => c.startsWith('mensual'))).toBe(true);

      const segunda = await comoUsuario(operativo).post('/api/integrations/huawei/sync-now').send({}).expect(200);
      expect(segunda.body.datos.consultado.some((c: string) => c.startsWith('mensual'))).toBe(false);
      expect(segunda.body.datos.consultado.length).toBeGreaterThan(0);
    });

    it('si Huawei alcanza su limite, responde con aviso claro y no con error', async () => {
      comportamiento = { tipo: 'ERROR', codigo: 'LIMITE_API', estado: 429, mensaje: 'limite' };
      const r = await comoUsuario(operativo).post('/api/integrations/huawei/sync-now').send({}).expect(200);
      expect(r.body.datos.limiteAlcanzado).toBe(true);
      expect(r.body.datos.estado).toBe('COMPLETADA_CON_ERRORES');
      expect(r.body.datos.mensaje).toContain('limite de consultas');
      expect(r.body.datos.advertencias.join(' ')).toContain('vuelva a pulsar');
    });

    it('sin sesion se rechaza', async () => {
      await request(obtenerApp()).post('/api/integrations/huawei/sync-now').send({}).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Plantilla de planta completa
  // -------------------------------------------------------------------------
  describe('plantilla de planta completa', () => {
    async function xlsx(filas: Array<Array<string | number | null>>): Promise<Buffer> {
      const libro = new ExcelJS.Workbook();
      const hoja = libro.addWorksheet('Produccion');
      hoja.addRow(['Planta', 'Grupo', 'Inversor', 'Año', 'Mes', 'Generacion', 'Comentarios']);
      filas.forEach((f) => hoja.addRow(f));
      return Buffer.from(await libro.xlsx.writeBuffer());
    }

    async function cargar(buffer: Buffer, ajustes: Record<string, unknown> = {}) {
      const prev = await comoUsuario(admin)
        .post('/api/imports/preview')
        .attach('archivo', buffer, 'planta.xlsx')
        .expect(200);
      const confirmar = await comoUsuario(admin)
        .post(`/api/imports/${prev.body.datos.id_historico}/confirm`)
        .send({ aceptarCargaParcial: true, ...ajustes });
      return { prev: prev.body.datos, confirmar };
    }

    let planta: string;
    let nombreGrupoB: string;
    beforeEach(async () => {
      const p = await queryOne<{ nombre: string }>('SELECT nombre FROM proyectos WHERE id_proyecto = ?', [datos.idProyecto]);
      planta = p!.nombre;
      nombreGrupoB = 'Grupo B';
    });

    it('descarga la plantilla ya rellenada con los grupos e inversores de la planta', async () => {
      await crearGrupo(datos.idProyecto, nombreGrupoB);
      const r = await comoUsuario(operativo)
        .get(`/api/imports/template?formato=PLANTA_COMPLETA&id_proyecto=${datos.idProyecto}&anio=2024`)
        .buffer(true)
        .parse((res, cb) => {
          const trozos: Buffer[] = [];
          res.on('data', (t: Buffer) => trozos.push(t));
          res.on('end', () => cb(null, Buffer.concat(trozos)));
        })
        .expect(200);
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(r.body as unknown as ArrayBuffer);
      const hoja = libro.getWorksheet('Produccion')!;
      expect(hoja.getRow(1).getCell(2).value).toBe('Grupo');
      // 2 inversores del grupo base + 1 fila de consolidado del Grupo B, por 12 meses.
      expect(hoja.rowCount - 1).toBe(12 * 3);
      const grupos = new Set<string>();
      hoja.eachRow((fila, n) => n > 1 && grupos.add(String(fila.getCell(2).value)));
      expect(grupos.has(nombreGrupoB)).toBe(true);
    });

    it('carga una planta completa separada por mes, grupo e inversor', async () => {
      await crearGrupo(datos.idProyecto, nombreGrupoB);
      const buffer = await xlsx([
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Enero', 1000, ''],
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Febrero', 1100, ''],
        [planta, 'Grupo B', null, 2024, 'Enero', 400, 'Consolidado del grupo B'],
        [planta, 'Grupo B', null, 2024, 'Febrero', 450, ''],
      ]);
      const { confirmar } = await cargar(buffer);
      expect(confirmar.status).toBe(200);
      expect(confirmar.body.datos.insertadas).toBe(4);

      const filas = await filasProduccion(datos.idProyecto);
      expect(filas.filter((f) => f.nivel_detalle === 'POR_INVERSOR').length).toBe(2);
      expect(filas.filter((f) => f.nivel_detalle === 'GRUPO_CONSOLIDADO').length).toBe(2);
      // Se suman ambos grupos (uno por inversor, otro consolidado) sin descartar ninguno.
      expect(await totalMes('2024-01-01', '2024-01-31')).toBe(1400);
      expect(await totalMes('2024-01-01', '2024-02-29')).toBe(2950);
    });

    it('las celdas de generacion vacias se ignoran sin generar error', async () => {
      const buffer = await xlsx([
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Enero', 1000, ''],
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Febrero', null, ''],
      ]);
      const { prev, confirmar } = await cargar(buffer);
      expect(prev.totales.errores).toBe(0);
      expect(confirmar.body.datos.insertadas).toBe(1);
    });

    it('descarta filas con grupo inexistente o inversor de otro grupo, y carga el resto', async () => {
      await crearGrupo(datos.idProyecto, nombreGrupoB);
      const buffer = await xlsx([
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Enero', 1000, ''],
        [planta, 'Grupo Fantasma', null, 2024, 'Enero', 500, ''],
        [planta, 'Grupo B', 'SN-MAN0', 2024, 'Enero', 700, 'El inversor es del otro grupo'],
      ]);
      const { prev, confirmar } = await cargar(buffer);
      const codigos = prev.problemas.map((p: { codigo: string }) => p.codigo);
      expect(codigos).toContain('GRUPO_NO_ENCONTRADO');
      expect(codigos).toContain('INVERSOR_FUERA_DE_GRUPO');
      expect(confirmar.body.datos.insertadas).toBe(1);
    });

    it('rechaza la misma combinacion de grupo, inversor y mes repetida en el archivo', async () => {
      const buffer = await xlsx([
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Enero', 1000, ''],
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Enero', 2000, 'repetida'],
      ]);
      const { prev, confirmar } = await cargar(buffer);
      expect(prev.problemas.map((p: { codigo: string }) => p.codigo)).toContain('FILA_REPETIDA');
      expect(confirmar.body.datos.insertadas).toBe(1);
      expect(await totalMes('2024-01-01', '2024-01-31')).toBe(1000);
    });

    it('cargar dos veces el mismo archivo actualiza y no suma', async () => {
      const buffer = await xlsx([
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Enero', 1000, ''],
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Febrero', 1100, ''],
      ]);
      await cargar(buffer);
      const segunda = await cargar(buffer, { politicaDuplicados: 'ACTUALIZAR' });
      expect(segunda.confirmar.body.datos.actualizadas).toBe(2);
      expect(await totalMes('2024-01-01', '2024-02-29')).toBe(2100);
      expect((await filasProduccion(datos.idProyecto)).length).toBe(2);
    });

    it('omite la fila manual de un inversor que Huawei ya sincronizo ese mes (no duplica energia)', async () => {
      await execute(
        `INSERT INTO produccion (id_proyecto, id_inversor, id_grupo, nivel_detalle, fecha, anio, mes,
                                 granularidad, kwh, origen, secuencia)
         VALUES (?, ?, ?, 'POR_INVERSOR', '2024-01-01', 2024, 1, 'MENSUAL', 800, 'HUAWEI_API', 0)`,
        [datos.idProyecto, datos.idInversorHuawei, datos.idGrupo],
      );
      const buffer = await xlsx([
        [planta, 'Grupo Pruebas', 'SN-HW0', 2024, 'Enero', 900, 'ya viene de Huawei'],
        [planta, 'Grupo Pruebas', 'SN-MAN0', 2024, 'Enero', 1000, ''],
      ]);
      const { prev, confirmar } = await cargar(buffer);
      expect(prev.problemas.map((p: { codigo: string }) => p.codigo)).toContain('YA_SINCRONIZADO_HUAWEI');
      expect(confirmar.body.datos.insertadas).toBe(1);
      expect(confirmar.body.datos.omitidas).toBe(1);
      expect(await totalMes('2024-01-01', '2024-01-31')).toBe(1800);
    });
  });
});
