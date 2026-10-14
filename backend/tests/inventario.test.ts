import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import supertest from 'supertest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearUsuario,
  iniciarSesion,
  limpiarDatos,
  obtenerApp,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { execute } from '../src/db/pool';

/** Inventario (stock) de proyectos en Excel. */
describe('Inventario de proyectos en Excel', () => {
  let operativo: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('inv.oper@retse.com.gt', 'OPERATIVO');
    operativo = await iniciarSesion('inv.oper@retse.com.gt', PASSWORD_PRUEBAS);
  }, 120000);

  beforeEach(async () => {
    await limpiarDatos();
    datos = await crearDatosBase();
    await execute(
      'UPDATE inversores SET cantidad_paneles = 100, potencia_panel_wp = 550 WHERE id_inversor = ?',
      [datos.idInversor],
    );
    await execute(
      `INSERT INTO produccion (id_proyecto, id_grupo, id_inversor, fecha, anio, mes, kwh, granularidad,
                               nivel_detalle, origen, secuencia, estado_valorizacion, activo)
       VALUES (?, ?, ?, '2026-01-10', 2026, 1, 1250.5, 'DIARIA', 'POR_INVERSOR', 'MANUAL', 1,
               'PENDIENTE_DE_TARIFA', 1)`,
      [datos.idProyecto, datos.idGrupo, datos.idInversor],
    );
  });

  afterAll(async () => {
    await cerrarTodo();
  });

  const descargar = async (consulta = '') => {
    const r = await comoUsuario(operativo)
      .get(`/api/reports/inventory/export${consulta}`)
      .buffer(true)
      .parse((res, cb) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => cb(null, Buffer.concat(trozos)));
      });
    return r;
  };

  it('genera un libro con resumen, proyectos, grupos, inversores, lotes y tarifas', async () => {
    const r = await descargar();
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toContain('inventario_proyectos_');

    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(r.body as Buffer);
    expect(libro.worksheets.map((h) => h.name)).toEqual([
      'Resumen',
      'Proyectos',
      'Grupos',
      'Inversores',
      'Lotes de paneles',
      'Tarifas',
    ]);

    const resumen = libro.getWorksheet('Resumen')!;
    const textoResumen: string[] = [];
    resumen.eachRow((fila) => textoResumen.push(fila.values!.toString()));
    expect(textoResumen.join('\n')).toContain('Proyectos,1');
    expect(textoResumen.join('\n')).toContain('Inversores,2');
    expect(textoResumen.join('\n')).toContain('Paneles instalados');

    const proyectos = libro.getWorksheet('Proyectos')!;
    // encabezado + 1 proyecto + fila de total
    expect(proyectos.rowCount).toBe(3);
    const fila = proyectos.getRow(2);
    expect(fila.getCell(3).value).toBe('Planta Pruebas');
    expect(fila.getCell(12).value).toBe(100);
    expect(fila.getCell(13).value).toBe(55);
    expect(Number(fila.getCell(14).value)).toBeCloseTo(1250.5, 3);
    const total = proyectos.getRow(3);
    expect(total.getCell(1).value).toBe('TOTAL');
    expect(total.getCell(11).value).toBe(2);
    expect(Number(total.getCell(14).value)).toBeCloseTo(1250.5, 3);

    expect(libro.getWorksheet('Inversores')!.rowCount).toBe(3);
    expect(libro.getWorksheet('Grupos')!.rowCount).toBe(2);
  });

  it('puede filtrarse por cliente y solo activos', async () => {
    const otro = await crearDatosBase('B');
    await execute('UPDATE proyectos SET activo = 0 WHERE id_proyecto = ?', [otro.idProyecto]);

    const todos = new ExcelJS.Workbook();
    await todos.xlsx.load((await descargar()).body as Buffer);
    expect(todos.getWorksheet('Proyectos')!.rowCount).toBe(4); // 2 proyectos + encabezado + total

    const activos = new ExcelJS.Workbook();
    await activos.xlsx.load((await descargar('?solo_activos=1')).body as Buffer);
    expect(activos.getWorksheet('Proyectos')!.rowCount).toBe(3);

    const delCliente = new ExcelJS.Workbook();
    await delCliente.xlsx.load((await descargar(`?id_cliente=${datos.idCliente}`)).body as Buffer);
    expect(delCliente.getWorksheet('Proyectos')!.rowCount).toBe(3);
  });

  it('exige sesion', async () => {
    await supertest(obtenerApp()).get('/api/reports/inventory/export').expect(401);
  });
});
