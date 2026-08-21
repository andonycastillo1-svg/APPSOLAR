import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearUsuario,
  iniciarSesion,
  limpiarDatos,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { porcentajeCumplimiento, variacionPorcentual } from '../src/utils/numeros';

/**
 * Proyecciones, agregaciones, comparaciones y reportes.
 */
describe('Analisis, proyecciones y reportes', () => {
  let admin: Sesion;
  let operativo: Sesion;
  let gerencial: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('an.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('an.oper@retse.com.gt', 'OPERATIVO');
    await crearUsuario('an.ger@retse.com.gt', 'GERENCIAL');
    admin = await iniciarSesion('an.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('an.oper@retse.com.gt', PASSWORD_PRUEBAS);
    gerencial = await iniciarSesion('an.ger@retse.com.gt', PASSWORD_PRUEBAS);

    await limpiarDatos();
    datos = await crearDatosBase();

    // --- Tarifas: distintas por mes, con marzo 2026 deliberadamente ausente.
    const tarifas: Array<[number, number, number]> = [
      [2025, 1, 1.0],
      [2025, 2, 1.0],
      [2026, 1, 2.0],
      [2026, 2, 3.0],
    ];
    for (const [anio, mes, costo] of tarifas) {
      await comoUsuario(admin)
        .post(`/api/projects/${datos.idProyecto}/rates`)
        .send({ anio, mes, costo_kwh: costo, aprobarInmediato: true })
        .expect(201);
    }

    // --- Proyecciones aprobadas de 2026.
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/projections`)
      .send({
        anio: 2026,
        aprobarInmediato: true,
        meses: [
          { mes: 1, proyeccion_kwh: 1000 },
          { mes: 2, proyeccion_kwh: 1000 },
          { mes: 3, proyeccion_kwh: 1000 },
        ],
      })
      .expect(201);

    // --- Produccion por inversor.
    const registros: Array<[string, number]> = [
      ['2025-01-15', 500],
      ['2025-02-15', 500],
      ['2026-01-15', 1200],
      ['2026-02-15', 900],
      ['2026-03-15', 400],
    ];
    for (const [fecha, kwh] of registros) {
      await comoUsuario(operativo)
        .post('/api/production')
        .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha, kwh })
        .expect(201);
    }
  }, 180000);

  afterAll(async () => {
    await cerrarTodo();
  });

  // -------------------------------------------------------------------------
  // Utilidades de calculo
  // -------------------------------------------------------------------------

  it('calcula cumplimiento y variacion protegiendo las divisiones invalidas', () => {
    expect(porcentajeCumplimiento(1200, 1000)).toBe(120);
    expect(porcentajeCumplimiento(500, 0)).toBeNull();
    expect(porcentajeCumplimiento(500, null)).toBeNull();
    expect(variacionPorcentual(1200, 1000)).toBe(20);
    expect(variacionPorcentual(1200, 0)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Proyecciones
  // -------------------------------------------------------------------------

  it('calcula el cumplimiento mensual y anual de la proyeccion', async () => {
    const respuesta = await comoUsuario(gerencial)
      .get(`/api/projects/${datos.idProyecto}/projections?anio=2026`)
      .expect(200);

    const calendario = respuesta.body.datos.calendario;
    expect(Number(calendario[0].generacion_kwh)).toBe(1200);
    expect(Number(calendario[0].cumplimiento)).toBe(120);
    expect(Number(calendario[1].cumplimiento)).toBe(90);
    expect(Number(calendario[2].cumplimiento)).toBe(40);

    // Un mes sin proyeccion muestra "Sin proyeccion" y no divide entre cero.
    expect(calendario[5].cumplimiento).toBeNull();
    expect(calendario[5].etiquetaCumplimiento).toBe('Sin proyeccion');

    const totales = respuesta.body.datos.totales;
    expect(Number(totales.proyeccion_kwh)).toBe(3000);
    expect(Number(totales.generacion_kwh)).toBe(2500);
    expect(Number(totales.cumplimiento)).toBeCloseTo(83.33, 1);
    expect(totales.mesesSinProyeccion).toBe(9);
  });

  it('exige el anio de forma explicita al capturar proyecciones', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/projections`)
      .send({ meses: [{ mes: 1, proyeccion_kwh: 100 }] })
      .expect(422);
  });

  it('copia las proyecciones de otro anio como borrador y solo tras confirmarlo', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/projections/copy-year`)
      .send({ anioOrigen: 2026, anioDestino: 2027, factor: 1.1 })
      .expect(422);

    const copia = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/projections/copy-year`)
      .send({ anioOrigen: 2026, anioDestino: 2027, factor: 1.1, confirmado: true })
      .expect(201);

    expect(copia.body.datos.copiadas).toBe(3);

    const destino = await comoUsuario(admin)
      .get(`/api/projects/${datos.idProyecto}/projections?anio=2027`)
      .expect(200);

    expect(destino.body.datos.calendario[0].proyeccion.estado).toBe('BORRADOR');
    expect(Number(destino.body.datos.calendario[0].proyeccion.proyeccion_kwh)).toBe(1100);
    // Un borrador no cuenta como proyeccion aprobada.
    expect(Number(destino.body.datos.totales.proyeccion_kwh)).toBe(0);

    const aprobacion = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/projections/approve-year`)
      .send({ anio: 2027 })
      .expect(200);
    expect(aprobacion.body.datos.aprobadas).toBe(3);
  });

  it('un operativo sin permiso no puede gestionar proyecciones', async () => {
    await comoUsuario(operativo)
      .post(`/api/projects/${datos.idProyecto}/projections`)
      .send({ anio: 2026, meses: [{ mes: 4, proyeccion_kwh: 100 }] })
      .expect(403);
  });

  // -------------------------------------------------------------------------
  // Agregaciones y comparaciones
  // -------------------------------------------------------------------------

  it('agrega la produccion por dia, mes y anio', async () => {
    const mensual = await comoUsuario(gerencial)
      .get(`/api/production/timeseries?desde=2026-01-01&hasta=2026-03-31&granularidad=MENSUAL&id_proyecto=${datos.idProyecto}`)
      .expect(200);
    expect(mensual.body.datos).toHaveLength(3);
    expect(mensual.body.datos[0].etiqueta).toBe('Enero 2026');
    expect(Number(mensual.body.datos[0].kwh)).toBe(1200);

    const diaria = await comoUsuario(gerencial)
      .get(`/api/production/timeseries?desde=2026-01-01&hasta=2026-01-31&granularidad=DIARIA&id_proyecto=${datos.idProyecto}`)
      .expect(200);
    expect(diaria.body.datos).toHaveLength(1);
    expect(diaria.body.datos[0].etiqueta).toBe('15/01/2026');

    const anual = await comoUsuario(gerencial)
      .get(`/api/production/timeseries?desde=2025-01-01&hasta=2026-12-31&granularidad=ANUAL&id_proyecto=${datos.idProyecto}`)
      .expect(200);
    expect(anual.body.datos).toHaveLength(2);
    expect(Number(anual.body.datos[0].kwh)).toBe(1000);
    expect(Number(anual.body.datos[1].kwh)).toBe(2500);
  });

  it('calcula el valor economico usando varias tarifas dentro del mismo rango', async () => {
    const resumen = await comoUsuario(gerencial)
      .get(`/api/production/summary?desde=2026-01-01&hasta=2026-02-28&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    // 1200 x 2.0 + 900 x 3.0 = 2400 + 2700 = 5100
    expect(Number(resumen.body.datos.kwh)).toBe(2100);
    expect(Number(resumen.body.datos.valor_q)).toBe(5100);
    expect(resumen.body.datos.moneda).toBe('GTQ');
    expect(resumen.body.datos.zonaHoraria).toBe('America/Guatemala');
  });

  it('reporta la cobertura tarifaria y los registros pendientes del periodo', async () => {
    const resumen = await comoUsuario(gerencial)
      .get(`/api/production/summary?desde=2026-01-01&hasta=2026-03-31&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    const cobertura = resumen.body.datos.coberturaTarifaria;
    expect(cobertura.completa).toBe(false);
    expect(cobertura.mesesConTarifa).toHaveLength(2);
    expect(cobertura.mesesPendientes).toEqual([{ anio: 2026, mes: 3 }]);
    expect(cobertura.registrosPendientes).toBe(1);
    expect(Number(cobertura.kwhPendientes)).toBe(400);
  });

  it('compara con el periodo anterior equivalente y entre inversores', async () => {
    const respuesta = await comoUsuario(gerencial)
      .get(`/api/production/compare?desde=2026-01-01&hasta=2026-02-28&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    expect(respuesta.body.datos.baseComparacion).toContain('Periodo anterior equivalente');
    expect(respuesta.body.datos.proyectos).toHaveLength(1);
    expect(Number(respuesta.body.datos.proyectos[0].kwh)).toBe(2100);
    expect(respuesta.body.datos.rendimiento.baseComparacion).toContain('kWh/kWp');
  });

  it('produce el resumen anual con proyeccion, anio anterior y cumplimiento', async () => {
    const respuesta = await comoUsuario(gerencial)
      .get(`/api/production/annual-summary?anio=2026&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    const filas = respuesta.body.datos.filas;
    expect(filas).toHaveLength(12);

    const enero = filas[0];
    expect(enero.mesNombre).toBe('Enero');
    expect(Number(enero.proyeccion_kwh)).toBe(1000);
    expect(Number(enero.generacion_anio_anterior)).toBe(500);
    expect(Number(enero.cumplimiento_anio_anterior)).toBe(50);
    expect(Number(enero.generacion_anio_seleccionado)).toBe(1200);
    expect(Number(enero.cumplimiento_anio_seleccionado)).toBe(120);
    expect(Number(enero.tarifa_q_kwh)).toBe(2);
    expect(Number(enero.valor_producido_q)).toBe(2400);
    expect(enero.pendiente_de_tarifa).toBe(false);

    // Marzo tiene generacion pero no tarifa: el valor queda pendiente.
    const marzo = filas[2];
    expect(Number(marzo.generacion_anio_seleccionado)).toBe(400);
    expect(marzo.tarifa_q_kwh).toBeNull();
    expect(marzo.valor_producido_q).toBeNull();
    expect(marzo.pendiente_de_tarifa).toBe(true);

    const totales = respuesta.body.datos.totales;
    expect(Number(totales.generacion_anio_seleccionado)).toBe(2500);
    expect(Number(totales.generacion_anio_anterior)).toBe(1000);
    expect(Number(totales.valor_producido_q)).toBe(5100);
    expect(Number(totales.mesesPendientes)).toBe(1);
    expect(respuesta.body.meta.advertencia).toContain('parcial');
  });

  // -------------------------------------------------------------------------
  // Tablero
  // -------------------------------------------------------------------------

  it('el tablero entrega indicadores, tarifas aplicadas y factores ambientales con su fuente', async () => {
    const respuesta = await comoUsuario(gerencial)
      .get(`/api/dashboard?desde=2026-01-01&hasta=2026-03-31&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    const d = respuesta.body.datos;
    expect(Number(d.produccion.periodo_kwh)).toBe(2500);
    expect(Number(d.produccion.valor_q)).toBe(5100);
    expect(Number(d.proyeccion.kwh)).toBe(3000);
    expect(d.proyeccion.mesesConProyeccion).toBe(3);
    expect(d.proyeccion.mesesDelPeriodo).toBe(3);
    expect(Number(d.proyeccion.cumplimiento)).toBeCloseTo(83.33, 1);

    expect(d.tarifas.aplicadasPorMes).toHaveLength(2);
    expect(d.tarifas.advertencia).toContain('sin tarifa aprobada');

    expect(d.ambiental.factor_co2_unidad).toBe('tCO2e/MWh');
    expect(d.ambiental.factor_co2_fuente).not.toBe('No configurada');
    expect(d.ambiental.co2_por_arbol_unidad).toContain('arbol');

    expect(d.meta.moneda).toBe('GTQ');
    expect(d.meta.unidadPotencia).toBe('kWp');
    expect(d.meta.unidadEnergia).toBe('kWh');
  });

  // -------------------------------------------------------------------------
  // Reportes
  // -------------------------------------------------------------------------

  it('genera un reporte con desglose mensual integrado y advertencia de parcialidad', async () => {
    const respuesta = await comoUsuario(gerencial)
      .post('/api/reports/generate')
      .send({
        tipo: 'VALORIZACION',
        nombre: 'Reporte de pruebas',
        desde: '2026-01-01',
        hasta: '2026-03-31',
        id_proyecto: datos.idProyecto,
        granularidad: 'MENSUAL',
        anio: 2026,
        guardar: true,
      })
      .expect(201);

    const r = respuesta.body.datos;
    expect(r.id_reporte).toBeGreaterThan(0);
    expect(Number(r.resumen.kwh)).toBe(2500);
    expect(Number(r.resumen.valor_q)).toBe(5100);
    expect(r.cobertura.completa).toBe(false);
    expect(r.advertenciaOficial).toContain('NO puede considerarse un documento oficial completo');

    const enero = r.desgloseMensual.find((f: { mes: string }) => f.mes.startsWith('Enero'));
    expect(Number(enero.proyeccion_kwh)).toBe(1000);
    expect(Number(enero.generacion_kwh)).toBe(1200);
    expect(Number(enero.cumplimiento)).toBe(120);
    expect(Number(enero.tarifa_q_kwh)).toBe(2);
    expect(Number(enero.valor_q)).toBe(2400);
    expect(enero.estado).toBe('VALORIZADO');

    const marzo = r.desgloseMensual.find((f: { mes: string }) => f.mes.startsWith('Marzo'));
    expect(marzo.estado).toBe('PENDIENTE DE TARIFA');

    expect(r.notas.join(' ')).toContain('doble conteo');
    expect(r.notas.join(' ')).toContain('America/Guatemala');
  });

  it('exporta el reporte a PDF, CSV y XLSX', async () => {
    const generado = await comoUsuario(gerencial)
      .post('/api/reports/generate')
      .send({
        tipo: 'PRODUCCION',
        desde: '2026-01-01',
        hasta: '2026-02-28',
        id_proyecto: datos.idProyecto,
        anio: 2026,
        guardar: true,
      })
      .expect(201);

    const id = generado.body.datos.id_reporte;

    const pdf = await comoUsuario(gerencial).get(`/api/reports/${id}/export?formato=pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.length).toBeGreaterThan(1000);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    const csv = await comoUsuario(gerencial).get(`/api/reports/${id}/export?formato=csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Mes');
    expect(csv.text).toContain('Enero 2026');

    const xlsx = await comoUsuario(gerencial)
      .get(`/api/reports/${id}/export?formato=xlsx`)
      .responseType('blob')
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    // Todo XLSX es un contenedor OOXML (ZIP).
    expect(Buffer.from(xlsx.body).subarray(0, 2).toString('hex')).toBe('504b');
  });

  it('guarda el reporte con su cobertura tarifaria y aparece en el historial', async () => {
    const historial = await comoUsuario(gerencial).get('/api/reports').expect(200);
    expect(historial.body.datos.length).toBeGreaterThan(0);
    const parcial = historial.body.datos.find((r: { nombre: string }) => r.nombre === 'Reporte de pruebas');
    expect(parcial.cobertura_tarifaria).toBe('PARCIAL');
  });

  it('un usuario gerencial puede generar y exportar pero nunca modificar datos', async () => {
    await comoUsuario(gerencial)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-04-01', kwh: 10 })
      .expect(403);

    await comoUsuario(gerencial)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, mes: 4, costo_kwh: 1 })
      .expect(403);
  });

  it('valida el rango de fechas de las consultas', async () => {
    const respuesta = await comoUsuario(gerencial)
      .get('/api/production/summary?desde=2026-03-01&hasta=2026-01-01')
      .expect(422);
    expect(respuesta.body.error.mensaje).toContain('posterior a la fecha final');
  });
});
