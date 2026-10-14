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

  const hoy = new Date().toISOString().slice(0, 10);

  /** Genera el reporte INVENTARIO y descarga su Excel. */
  const generar = async (extra: Record<string, unknown> = {}) => {
    const creado = await comoUsuario(operativo)
      .post('/api/reports/generate')
      .send({ tipo: 'INVENTARIO', desde: '2026-01-01', hasta: hoy, guardar: true, ...extra })
      .expect(201);
    const r = await comoUsuario(operativo)
      .get(`/api/reports/${creado.body.datos.id_reporte}/export?formato=xlsx`)
      .buffer(true)
      .parse((res, cb) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => cb(null, Buffer.concat(trozos)));
      });
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(r.body as Buffer);
    return { creado: creado.body.datos, libro, respuesta: r };
  };

  it('es un tipo de reporte: una fila por proyecto con cliente, grupos, inversores y total', async () => {
    const { creado, libro, respuesta } = await generar();
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers['content-type']).toContain('spreadsheetml');

    // Lo que ve gerencia en pantalla
    expect(creado.inventario.filas).toHaveLength(1);
    const fila = creado.inventario.filas[0];
    expect(fila.cliente).toBe('Cliente Pruebas');
    expect(fila.proyecto).toBe('Planta Pruebas');
    expect(fila.grupos).toBe(1);
    expect(fila.inversores).toBe(2);
    expect(fila.paneles).toBe(100);
    expect(fila.produccion_kwh).toBeCloseTo(1250.5, 2);
    expect(creado.inventario.totales.proyectos).toBe(1);
    expect(creado.inventario.totales.inversores).toBe(2);

    // Y en el Excel: la primera hoja es la misma tabla de la vista
    expect(libro.worksheets.map((h) => h.name)).toEqual([
      'Inventario',
      'Datos de proyectos',
      'Grupos',
      'Inversores',
      'Lotes de paneles',
      'Tarifas',
      'Resumen y notas',
    ]);
    const hoja = libro.getWorksheet('Inventario')!;
    const encabezados = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((c) => hoja.getRow(4).getCell(c).value);
    expect(encabezados).toEqual([
      'Cliente',
      'Proyecto',
      'Grupos',
      'Inversores',
      'Paneles',
      'Potencia kWp',
      'Produccion kWh',
      'Valor Q',
      'Modalidad',
      'Suministradora',
      'Estado',
    ]);
    expect(hoja.rowCount).toBe(6); // titulo, filtros, vacia, encabezado, proyecto, total
    const datosFila = hoja.getRow(5);
    expect(datosFila.getCell(1).value).toBe('Cliente Pruebas');
    expect(datosFila.getCell(2).value).toBe('Planta Pruebas');
    expect(datosFila.getCell(3).value).toBe(1);
    expect(datosFila.getCell(4).value).toBe(2);
    expect(datosFila.getCell(5).value).toBe(100);
    expect(Number(datosFila.getCell(7).value)).toBeCloseTo(1250.5, 2);
    expect(String(datosFila.getCell(10).value)).toContain('Distribuidora');
    const total = hoja.getRow(6);
    expect(total.getCell(1).value).toBe('TOTAL');
    expect(total.getCell(4).value).toBe(2);
    expect(Number(total.getCell(7).value)).toBeCloseTo(1250.5, 2);
    expect(libro.getWorksheet('Inversores')!.rowCount).toBe(3);
    expect(libro.getWorksheet('Grupos')!.rowCount).toBe(2);
  });

  it('se repite por cada proyecto y suma el total general', async () => {
    const otro = await crearDatosBase('B');
    await execute(
      `INSERT INTO produccion (id_proyecto, id_grupo, id_inversor, fecha, anio, mes, kwh, granularidad,
                               nivel_detalle, origen, secuencia, estado_valorizacion, activo)
       VALUES (?, ?, ?, '2026-02-10', 2026, 2, 749.5, 'DIARIA', 'POR_INVERSOR', 'MANUAL', 1,
               'PENDIENTE_DE_TARIFA', 1)`,
      [otro.idProyecto, otro.idGrupo, otro.idInversor],
    );
    const { creado, libro } = await generar();
    expect(creado.inventario.filas).toHaveLength(2);
    expect(creado.inventario.totales.proyectos).toBe(2);
    expect(creado.inventario.totales.produccion_kwh).toBeCloseTo(2000, 2);
    const hoja = libro.getWorksheet('Inventario')!;
    expect(hoja.rowCount).toBe(7); // 4 de cabecera + 2 proyectos + total
    expect(hoja.getRow(7).getCell(1).value).toBe('TOTAL');
    expect(Number(hoja.getRow(7).getCell(7).value)).toBeCloseTo(2000, 2);
  });

  it('puede filtrarse por cliente y solo activos', async () => {
    const otro = await crearDatosBase('B');
    await execute('UPDATE proyectos SET activo = 0 WHERE id_proyecto = ?', [otro.idProyecto]);

    expect((await generar()).creado.inventario.filas).toHaveLength(2);
    expect((await generar({ solo_activos: true })).creado.inventario.filas).toHaveLength(1);
    expect((await generar({ id_cliente: datos.idCliente })).creado.inventario.filas).toHaveLength(1);
  });

  it('exige sesion', async () => {
    await supertest(obtenerApp()).post('/api/reports/generate').send({ tipo: 'INVENTARIO' }).expect(401);
  });
});
