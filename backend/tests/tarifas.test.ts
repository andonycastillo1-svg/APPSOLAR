import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  contarAuditoria,
  crearDatosBase,
  crearUsuario,
  filasProduccion,
  iniciarSesion,
  limpiarDatos,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { execute, queryOne } from '../src/db/pool';
import { calcularValorQ, parsearNumero, redondear } from '../src/utils/numeros';
import { normalizarMes, normalizarFecha, periodoAnterior, mesesDelPeriodo } from '../src/utils/fechas';

describe('Tarifas trimestrales y valorizacion', () => {
  let admin: Sesion;
  let coordinador: Sesion;
  let operativo: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('tar.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('tar.coord@retse.com.gt', 'OPERATIVO', ['tarifas.gestionar']);
    await crearUsuario('tar.oper@retse.com.gt', 'OPERATIVO');

    admin = await iniciarSesion('tar.admin@retse.com.gt', PASSWORD_PRUEBAS);
    coordinador = await iniciarSesion('tar.coord@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('tar.oper@retse.com.gt', PASSWORD_PRUEBAS);
  }, 120000);

  beforeEach(async () => {
    await limpiarDatos();
    datos = await crearDatosBase();
  });

  afterAll(async () => {
    await cerrarTodo();
  });

  // -------------------------------------------------------------------------
  // Utilidades numericas y de fechas
  // -------------------------------------------------------------------------

  it('calcula valor_q = kwh x tarifa con redondeo documentado a 4 decimales', () => {
    expect(calcularValorQ(1000, 1.234567)).toBe(1234.567);
    expect(calcularValorQ(105751, 1.045)).toBe(110509.795);
    expect(calcularValorQ(0.5, 1.005)).toBe(0.5025);
    // El redondeo half-up es estable frente a los artefactos binarios.
    expect(redondear(1.005, 2)).toBe(1.01);
    expect(redondear(2.675, 2)).toBe(2.68);
  });

  it('normaliza numeros con separadores decimales y de miles', () => {
    expect(parsearNumero('1.234,56')).toBe(1234.56);
    expect(parsearNumero('1,234.56')).toBe(1234.56);
    expect(parsearNumero('45200')).toBe(45200);
    expect(parsearNumero('1,234')).toBe(1234);
    expect(parsearNumero('12,5')).toBe(12.5);
    expect(parsearNumero('abc')).toBeNull();
    expect(parsearNumero('')).toBeNull();
  });

  it('normaliza meses en espanol y fechas en varios formatos', () => {
    expect(normalizarMes('Enero')).toBe(1);
    expect(normalizarMes('diciembre')).toBe(12);
    expect(normalizarMes('Sept')).toBe(9);
    expect(normalizarMes('7')).toBe(7);
    expect(normalizarMes('Trecemberre')).toBeNull();
    expect(normalizarMes(13)).toBeNull();

    expect(normalizarFecha('2026-03-15')).toBe('2026-03-15');
    expect(normalizarFecha('15/03/2026')).toBe('2026-03-15');
    expect(normalizarFecha('2026-02-30')).toBeNull();
    expect(normalizarFecha('no es fecha')).toBeNull();
  });

  it('calcula el periodo anterior equivalente y los meses cubiertos', () => {
    expect(periodoAnterior({ desde: '2026-03-01', hasta: '2026-03-31' })).toEqual({
      desde: '2026-01-29',
      hasta: '2026-02-28',
    });
    expect(mesesDelPeriodo({ desde: '2025-11-05', hasta: '2026-02-10' })).toEqual([
      { anio: 2025, mes: 11 },
      { anio: 2025, mes: 12 },
      { anio: 2026, mes: 1 },
      { anio: 2026, mes: 2 },
    ]);
  });

  // -------------------------------------------------------------------------
  // Registro y aprobacion
  // -------------------------------------------------------------------------

  it('permite registrar tarifas diferentes en trimestres consecutivos', async () => {
    await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 1, costo_kwh: 1.15, aprobarInmediato: false })
      .expect(201);

    await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 2, costo_kwh: 1.32, aprobarInmediato: false })
      .expect(201);

    const calendario = await comoUsuario(coordinador)
      .get(`/api/projects/${datos.idProyecto}/rates?anio=2026`)
      .expect(200);

    const datosCalendario = calendario.body.datos;
    expect(datosCalendario.periodicidad).toBe('TRIMESTRAL');
    expect(datosCalendario.calendario).toHaveLength(4);

    const primero = datosCalendario.calendario[0];
    const segundo = datosCalendario.calendario[1];
    expect(primero.etiqueta).toBe('I trimestre');
    expect(primero.meses).toBe('Noviembre a Enero');
    expect(primero.mesesNumeros).toEqual([11, 12, 1]);
    expect(segundo.mesesNumeros).toEqual([2, 3, 4]);
    expect(Number(primero.tarifa.costo_kwh)).toBe(1.15);
    expect(Number(segundo.tarifa.costo_kwh)).toBe(1.32);
    expect(primero.tarifa.estado).toBe('BORRADOR');
    expect(datosCalendario.resumen.trimestresSinTarifa).toBe(2);
  });

  it('impide dos tarifas vigentes para el mismo proyecto, anio y mes', async () => {
    await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 2, costo_kwh: 1.1 })
      .expect(201);

    const duplicada = await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 2, costo_kwh: 1.2 })
      .expect(409);

    expect(duplicada.body.error.mensaje).toContain('Ya existe una tarifa');
  });

  it('rechaza tarifas negativas y trimestres invalidos', async () => {
    const negativa = await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 2, costo_kwh: -0.5 })
      .expect(422);
    expect(JSON.stringify(negativa.body.error.detalles)).toContain('negativo');

    const trimestreInvalido = await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 5, costo_kwh: 1.1 })
      .expect(422);
    expect(JSON.stringify(trimestreInvalido.body.error.detalles)).toMatch(/trimestre|4/i);
  });

  it('un operativo sin tarifas.gestionar no puede crear tarifas', async () => {
    await comoUsuario(operativo)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 3, costo_kwh: 1.1 })
      .expect(403);
  });

  it('el coordinador no puede aprobar por si mismo: la aprobacion es un permiso aparte', async () => {
    const respuesta = await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 3, costo_kwh: 1.1, aprobarInmediato: true })
      .expect(403);

    expect(respuesta.body.error.detalles.permiso).toBe('tarifas.aprobar');
  });

  // -------------------------------------------------------------------------
  // Valorizacion
  // -------------------------------------------------------------------------

  it('selecciona la tarifa del TRIMESTRE al que pertenece cada registro', async () => {
    // I trimestre (nov-ene) a Q 1.00 y II trimestre (feb-abr) a Q 2.00, anio tarifario 2025.
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 1, costo_kwh: 1.0, aprobarInmediato: true })
      .expect(201);
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 2, costo_kwh: 2.0, aprobarInmediato: true })
      .expect(201);

    // Enero 2026 cae en el I trimestre del anio tarifario 2025; abril, en el II.
    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-01-15', kwh: 100 })
      .expect(201);
    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-04-15', kwh: 100 })
      .expect(201);

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(2);
    expect(Number(filas[0].costo_kwh_aplicado)).toBe(1);
    expect(Number(filas[0].valor_q)).toBe(100);
    expect(Number(filas[1].costo_kwh_aplicado)).toBe(2);
    expect(Number(filas[1].valor_q)).toBe(200);

    // El total del rango es la suma por registro: 100x1 + 100x2 = 300,
    // NUNCA 200 kWh x la tarifa del ultimo mes.
    const resumen = await comoUsuario(admin)
      .get(`/api/production/summary?desde=2026-01-01&hasta=2026-04-30&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    expect(Number(resumen.body.datos.kwh)).toBe(200);
    expect(Number(resumen.body.datos.valor_q)).toBe(300);
  });

  it('aplica la MISMA tarifa a los tres meses de un trimestre', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 1, costo_kwh: 1.5, aprobarInmediato: true })
      .expect(201);

    for (const fecha of ['2025-11-10', '2025-12-10', '2026-01-10']) {
      await comoUsuario(admin)
        .post('/api/production')
        .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha, kwh: 100 })
        .expect(201);
    }

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(3);
    // Los tres meses comparten la tarifa del trimestre.
    expect(filas.every((f) => Number(f.costo_kwh_aplicado) === 1.5)).toBe(true);
    expect(filas.every((f) => Number(f.valor_q) === 150)).toBe(true);
  });

  it('un mes sin tarifa conserva los kWh y deja la valorizacion pendiente', async () => {
    const respuesta = await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-04-10', kwh: 250 })
      .expect(201);

    expect(respuesta.body.datos.estado_valorizacion).toBe('PENDIENTE_DE_TARIFA');
    expect(respuesta.body.datos.valor_q).toBeNull();
    expect(respuesta.body.datos.mensaje).toContain('PENDIENTE DE TARIFA');

    const filas = await filasProduccion(datos.idProyecto);
    expect(Number(filas[0].kwh)).toBe(250);
    expect(filas[0].valor_q).toBeNull();
    // Nunca se usa cero ni la tarifa de otro mes.
    expect(filas[0].costo_kwh_aplicado).toBeNull();

    const resumen = await comoUsuario(admin)
      .get(`/api/production/summary?desde=2026-04-01&hasta=2026-04-30&id_proyecto=${datos.idProyecto}`)
      .expect(200);
    expect(resumen.body.datos.coberturaTarifaria.completa).toBe(false);
    expect(resumen.body.datos.registrosPendientes).toBe(1);
  });

  it('al aprobar la tarifa faltante valoriza SOLO los registros pendientes de ese mes', async () => {
    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-05-10', kwh: 200 })
      .expect(201);
    // Agosto pertenece al IV trimestre: NO debe valorizarse al aprobar el III.
    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-08-10', kwh: 300 })
      .expect(201);

    const creada = await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 3, costo_kwh: 1.5 })
      .expect(201);

    const aprobada = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/${creada.body.datos.id_tarifa}/approve`)
      .expect(200);

    expect(aprobada.body.datos.valorizacion.registros).toBe(1);
    expect(Number(aprobada.body.datos.valorizacion.valor)).toBe(300);

    const filas = await filasProduccion(datos.idProyecto);
    expect(Number(filas[0].valor_q)).toBe(300);
    expect(filas[0].estado_valorizacion).toBe('VALORIZADA');
    // Agosto sigue pendiente: pertenece al IV trimestre, que no tiene tarifa.
    expect(filas[1].estado_valorizacion).toBe('PENDIENTE_DE_TARIFA');
    expect(filas[1].valor_q).toBeNull();
  });

  it('copiar la tarifa del trimestre anterior exige confirmacion explicita y crea un borrador', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 1, costo_kwh: 1.23, aprobarInmediato: true })
      .expect(201);

    // Sin confirmacion explicita la operacion se rechaza.
    await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates/copy-previous`)
      .send({ anio: 2026, trimestre: 2 })
      .expect(422);

    const copia = await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates/copy-previous`)
      .send({ anio: 2026, trimestre: 2, confirmado: true })
      .expect(201);

    expect(Number(copia.body.datos.costo_kwh)).toBe(1.23);
    expect(copia.body.datos.mensaje).toContain('BORRADOR');

    const tarifa = await queryOne<{ estado: string; origen: string }>(
      'SELECT estado, origen FROM tarifas_kwh WHERE id_tarifa = ?',
      [copia.body.datos.id_tarifa],
    );
    expect(tarifa?.estado).toBe('BORRADOR');
    expect(tarifa?.origen).toBe('COPIA_MES_ANTERIOR');
  });

  // -------------------------------------------------------------------------
  // Correccion con analisis de impacto
  // -------------------------------------------------------------------------

  it('corrige una tarifa ya utilizada solo tras analizar el impacto y con motivo', async () => {
    const tarifa = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 2, costo_kwh: 1.0, aprobarInmediato: true })
      .expect(201);
    const idTarifa = tarifa.body.datos.id_tarifa;

    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-03-05', kwh: 1000 })
      .expect(201);
    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-03-06', kwh: 500 })
      .expect(201);

    const impacto = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/${idTarifa}/impact`)
      .send({ costo_kwh: 1.25 })
      .expect(200);

    expect(impacto.body.datos.registrosAfectados).toBe(2);
    expect(Number(impacto.body.datos.kwhAfectados)).toBe(1500);
    expect(Number(impacto.body.datos.valorAnterior)).toBe(1500);
    expect(Number(impacto.body.datos.valorNuevo)).toBe(1875);
    expect(Number(impacto.body.datos.diferencia)).toBe(375);
    expect(impacto.body.datos.advertencia).toContain('registro(s) historicos');
    expect(impacto.body.datos.etiqueta).toBe('II trimestre 2025 (feb 2026 a abr 2026)');

    // Sin confirmacion o sin motivo suficiente se rechaza.
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/${idTarifa}/recalculate`)
      .send({ costo_kwh: 1.25, motivo: 'corto', confirmado: true })
      .expect(422);

    const antes = await contarAuditoria('TARIFA_RECALCULADA');

    const recalculo = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/${idTarifa}/recalculate`)
      .send({
        costo_kwh: 1.25,
        motivo: 'Correccion por addendum contractual numero 2026-03 firmado con el cliente.',
        confirmado: true,
      })
      .expect(200);

    expect(recalculo.body.datos.registros).toBe(2);
    expect(Number(recalculo.body.datos.valorAnterior)).toBe(1500);
    expect(Number(recalculo.body.datos.valorNuevo)).toBe(1875);

    const filas = await filasProduccion(datos.idProyecto);
    expect(Number(filas[0].valor_q)).toBe(1250);
    expect(Number(filas[1].valor_q)).toBe(625);

    // Debe existir auditoria con los valores antes y despues.
    expect(await contarAuditoria('TARIFA_RECALCULADA')).toBe(antes + 1);
    const auditoria = await queryOne<{ antes: string; despues: string; motivo: string }>(
      `SELECT CAST(datos_antes AS CHAR) AS antes, CAST(datos_despues AS CHAR) AS despues, motivo
         FROM auditoria WHERE accion = 'TARIFA_RECALCULADA' ORDER BY id_auditoria DESC LIMIT 1`,
    );
    expect(auditoria?.antes).toContain('1500');
    expect(auditoria?.despues).toContain('1875');
    expect(auditoria?.motivo).toContain('addendum');
  });

  it('un usuario sin tarifas.recalcular no puede corregir una tarifa aprobada', async () => {
    const tarifa = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2026, trimestre: 3, costo_kwh: 1.0, aprobarInmediato: true })
      .expect(201);

    await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates/${tarifa.body.datos.id_tarifa}/recalculate`)
      .send({ costo_kwh: 2, motivo: 'Intento sin autorizacion suficiente', confirmado: true })
      .expect(403);
  });

  it('anular una tarifa conserva los kWh y devuelve los registros a pendiente', async () => {
    const tarifa = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2024, trimestre: 4, costo_kwh: 1.4, aprobarInmediato: true })
      .expect(201);

    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2025-10-05', kwh: 100 })
      .expect(201);

    const anulacion = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/${tarifa.body.datos.id_tarifa}/annul`)
      .send({ motivo: 'Tarifa registrada por error en el contrato del cliente.' })
      .expect(200);

    expect(anulacion.body.datos.registrosDesvalorizados).toBe(1);

    const filas = await filasProduccion(datos.idProyecto);
    expect(Number(filas[0].kwh)).toBe(100);
    expect(filas[0].valor_q).toBeNull();
    expect(filas[0].estado_valorizacion).toBe('PENDIENTE_DE_TARIFA');

    // Tras anular se puede registrar una nueva tarifa para el mismo mes.
    await comoUsuario(coordinador)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2024, trimestre: 4, costo_kwh: 1.6 })
      .expect(201);
  });

  // -------------------------------------------------------------------------
  // Cierre mensual
  // -------------------------------------------------------------------------

  it('impide cerrar un mes con registros sin tarifa y bloquea cambios tras el cierre', async () => {
    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2025-11-05', kwh: 100 })
      .expect(201);

    const cierreFallido = await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/close`)
      .send({ anio: 2025, mes: 11 })
      .expect(409);
    expect(cierreFallido.body.error.mensaje).toContain('sin tarifa aprobada');

    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 1, costo_kwh: 1.1, aprobarInmediato: true })
      .expect(201);

    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/close`)
      .send({ anio: 2025, mes: 11, motivo: 'Cierre contable mensual' })
      .expect(200);

    // Con el mes cerrado no se admite nueva produccion de ese periodo.
    const bloqueado = await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2025-11-06', kwh: 50 })
      .expect(409);
    expect(bloqueado.body.error.mensaje).toContain('cerrado');

    // La reapertura exige motivo y permiso administrativo.
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/reopen`)
      .send({ anio: 2025, mes: 11, motivo: 'corto' })
      .expect(422);

    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/reopen`)
      .send({ anio: 2025, mes: 11, motivo: 'Reapertura autorizada por gerencia para corregir una lectura.' })
      .expect(200);

    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2025-11-06', kwh: 50 })
      .expect(201);
  });

  it('la correccion manual de produccion recalcula el valor y exige motivo auditado', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 1, costo_kwh: 2.0, aprobarInmediato: true })
      .expect(201);

    const registro = await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2025-12-05', kwh: 100 })
      .expect(201);

    const id = registro.body.datos.id_produccion;

    await comoUsuario(admin).put(`/api/production/${id}`).send({ kwh: 150, motivo: 'corto' }).expect(422);

    const correccion = await comoUsuario(admin)
      .put(`/api/production/${id}`)
      .send({ kwh: 150, motivo: 'Lectura corregida segun el reporte del inversor del 5 de diciembre.' })
      .expect(200);

    // El valor SIEMPRE se deriva: 150 x 2.0 = 300.
    expect(Number(correccion.body.datos.valor_q)).toBe(300);

    const ajuste = await queryOne<{ kwh_antes: number; kwh_despues: number; valor_antes: number; valor_despues: number }>(
      'SELECT kwh_antes, kwh_despues, valor_antes, valor_despues FROM produccion_ajustes WHERE id_produccion = ?',
      [id],
    );
    expect(Number(ajuste?.kwh_antes)).toBe(100);
    expect(Number(ajuste?.kwh_despues)).toBe(150);
    expect(Number(ajuste?.valor_antes)).toBe(200);
    expect(Number(ajuste?.valor_despues)).toBe(300);
  });

  it('rechaza produccion con energia negativa o fecha futura', async () => {
    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-05-01', kwh: -10 })
      .expect(422);

    await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2099-01-01', kwh: 10 })
      .expect(422);
  });

  it('impide registrar produccion de un inversor que no pertenece al proyecto', async () => {
    const otros = await crearDatosBase('B');
    const respuesta = await comoUsuario(admin)
      .post('/api/production')
      .send({ id_proyecto: datos.idProyecto, id_inversor: otros.idInversor, fecha: '2026-05-02', kwh: 10 })
      .expect(422);

    expect(respuesta.body.error.mensaje).toContain('no pertenece al proyecto');
    await execute('DELETE FROM inversores WHERE id_proyecto = ?', [otros.idProyecto]);
  });
});

/**
 * Alerta de actualizacion trimestral.
 *
 * La tarifa del kWh se actualiza cada trimestre tarifario, asi que el sistema
 * debe avisar al usuario cuando el trimestre en curso no tiene tarifa aprobada
 * y, con anticipacion, cuando el trimestre siguiente tampoco la tiene.
 */
describe('Alerta de actualizacion trimestral de la tarifa', () => {
  let admin: Sesion;
  let gerencial: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('al.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('al.ger@retse.com.gt', 'GERENCIAL');
    admin = await iniciarSesion('al.admin@retse.com.gt', PASSWORD_PRUEBAS);
    gerencial = await iniciarSesion('al.ger@retse.com.gt', PASSWORD_PRUEBAS);

    await limpiarDatos();
    datos = await crearDatosBase('-alerta');
  }, 120000);

  afterAll(async () => {
    await cerrarTodo();
  });

  it('avisa que el trimestre en curso no tiene tarifa aprobada', async () => {
    const alerta = await comoUsuario(gerencial)
      .get(`/api/projects/${datos.idProyecto}/rates/alert`)
      .expect(200);

    const a = alerta.body.datos;
    expect(a.requiereAtencion).toBe(true);
    expect(a.proyectosSinTarifaActual).toHaveLength(1);
    expect(a.mensaje).toContain('no tienen tarifa aprobada');
    expect(a.mensaje).toContain('sin valor economico');
    expect(a.trimestreActual.etiqueta).toMatch(/^(I|II|III|IV) trimestre \d{4} \(.+\)$/);
    expect(a.diasRestantes).toBeGreaterThanOrEqual(0);
  });

  it('el trimestre siguiente al actual nunca es el mismo', async () => {
    const alerta = await comoUsuario(gerencial)
      .get(`/api/projects/${datos.idProyecto}/rates/alert`)
      .expect(200);

    const a = alerta.body.datos;
    expect(a.trimestreSiguiente.etiqueta).not.toBe(a.trimestreActual.etiqueta);
    if (a.trimestreActual.trimestre === 4) {
      expect(a.trimestreSiguiente.anio).toBe(a.trimestreActual.anio + 1);
      expect(a.trimestreSiguiente.trimestre).toBe(1);
    } else {
      expect(a.trimestreSiguiente.trimestre).toBe(a.trimestreActual.trimestre + 1);
    }
  });

  it('la alerta del trimestre en curso desaparece al aprobar su tarifa', async () => {
    const previa = await comoUsuario(gerencial)
      .get(`/api/projects/${datos.idProyecto}/rates/alert`)
      .expect(200);
    const { anio, trimestre } = previa.body.datos.trimestreActual;

    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio, trimestre, costo_kwh: 1.25, aprobarInmediato: true })
      .expect(201);

    const despues = await comoUsuario(gerencial)
      .get(`/api/projects/${datos.idProyecto}/rates/alert`)
      .expect(200);

    expect(despues.body.datos.proyectosSinTarifaActual).toHaveLength(0);

    // Con menos dias que el umbral de aviso, la alerta se mantiene por el
    // trimestre siguiente, que todavia no tiene tarifa registrada.
    if (despues.body.datos.diasRestantes <= despues.body.datos.diasDeAviso) {
      expect(despues.body.datos.requiereAtencion).toBe(true);
      expect(despues.body.datos.mensaje).toContain('antes del cambio de trimestre');
    } else {
      expect(despues.body.datos.requiereAtencion).toBe(false);
      expect(despues.body.datos.mensaje).toBeNull();
    }
  });

  it('el tablero publica la misma alerta junto a los indicadores', async () => {
    const tablero = await comoUsuario(gerencial)
      .get(`/api/dashboard?desde=2026-01-01&hasta=2026-12-31&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    expect(tablero.body.datos.tarifas.periodicidad).toBe('TRIMESTRAL');
    expect(tablero.body.datos.tarifas.alertaTrimestral.trimestreActual).toBeTruthy();
  });

  it('un usuario sin permiso de tarifas no consulta la alerta', async () => {
    await crearUsuario('al.sin@retse.com.gt', 'OPERATIVO', [], ['tarifas.ver']);
    const sinPermiso = await iniciarSesion('al.sin@retse.com.gt', PASSWORD_PRUEBAS);
    await comoUsuario(sinPermiso)
      .get(`/api/projects/${datos.idProyecto}/rates/alert`)
      .expect(403);
  });
});
