import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearUsuario,
  filasProduccion,
  iniciarSesion,
  levantarPythonSimulado,
  limpiarDatos,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type ComportamientoPython,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { env } from '../src/config/env';
import { execute, query, queryOne } from '../src/db/pool';

/**
 * Integracion Huawei SmartPVMS.
 * El servicio Python se sustituye por un doble que respeta su mismo contrato
 * HTTP, de modo que las pruebas no dependen del fabricante ni de la red.
 */
describe('Sincronizacion Huawei SmartPVMS', () => {
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
    await crearUsuario('hw.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('hw.oper@retse.com.gt', 'OPERATIVO');
    await crearUsuario('hw.ger@retse.com.gt', 'GERENCIAL');
    admin = await iniciarSesion('hw.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('hw.oper@retse.com.gt', PASSWORD_PRUEBAS);
    gerencial = await iniciarSesion('hw.ger@retse.com.gt', PASSWORD_PRUEBAS);

    const stub = await levantarPythonSimulado(() => comportamiento);
    cerrarStub = stub.cerrar;
    // El cliente lee la URL en cada llamada: basta con apuntarla al doble.
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

  // -------------------------------------------------------------------------
  // Caso exitoso
  // -------------------------------------------------------------------------

  it('sincroniza correctamente y valoriza con la tarifa del mes', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, mes: 5, costo_kwh: 1.5, aprobarInmediato: true })
      .expect(201);

    comportamiento = {
      tipo: 'EXITO',
      registros: [
        { serial: 'SN-HW0', fecha: '2025-05-01', kwh: 100 },
        { serial: 'SN-HW0', fecha: '2025-05-02', kwh: 120 },
      ],
    };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-02', granularidad: 'DIARIA' })
      .expect(200);

    expect(respuesta.body.datos.estado).toBe('COMPLETADA');
    expect(respuesta.body.datos.insertadas).toBe(2);
    expect(respuesta.body.datos.rechazadas).toBe(0);
    expect(respuesta.body.datos.esSimulado).toBe(true);
    expect(respuesta.body.datos.etiquetaOrigen).toContain('SIMULADOS');

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(2);
    expect(Number(filas[0].valor_q)).toBe(150);
    expect(Number(filas[1].valor_q)).toBe(180);
    expect(filas.every((f) => f.nivel_detalle === 'POR_INVERSOR')).toBe(true);

    // La ejecucion queda registrada con sus metricas.
    const ejecucion = await queryOne<{
      estado: string;
      filas_recibidas: number;
      insertadas: number;
      duracion_ms: number;
      modo: string;
    }>('SELECT * FROM sincronizaciones ORDER BY id_sync DESC LIMIT 1');
    expect(ejecucion?.estado).toBe('COMPLETADA');
    expect(Number(ejecucion?.filas_recibidas)).toBe(2);
    expect(ejecucion?.modo).toBe('MOCK');
    expect(Number(ejecucion?.duracion_ms)).toBeGreaterThanOrEqual(0);
  });

  it('es idempotente: repetir el mismo rango actualiza y no duplica', async () => {
    comportamiento = {
      tipo: 'EXITO',
      registros: [{ serial: 'SN-HW0', fecha: '2025-05-01', kwh: 100 }],
    };

    const primera = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(200);
    expect(primera.body.datos.insertadas).toBe(1);

    const segunda = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(200);
    expect(segunda.body.datos.insertadas).toBe(0);
    expect(segunda.body.datos.actualizadas).toBe(1);

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(1);
  });

  it('conserva los kWh y deja pendiente el valor cuando el mes no tiene tarifa', async () => {
    comportamiento = {
      tipo: 'EXITO',
      registros: [{ serial: 'SN-HW0', fecha: '2025-07-01', kwh: 80 }],
    };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-07-01', hasta: '2025-07-01' })
      .expect(200);

    expect(respuesta.body.datos.pendientesTarifa).toBe(1);
    const filas = await filasProduccion(datos.idProyecto);
    expect(Number(filas[0].kwh)).toBe(80);
    expect(filas[0].estado_valorizacion).toBe('PENDIENTE_DE_TARIFA');
  });

  // -------------------------------------------------------------------------
  // Validaciones y datos anomalos
  // -------------------------------------------------------------------------

  it('rechaza registros con seriales desconocidos, fechas futuras o energia invalida', async () => {
    comportamiento = {
      tipo: 'EXITO',
      registros: [
        { serial: 'SN-HW0', fecha: '2025-05-01', kwh: 100 },
        { serial: 'SERIAL-DESCONOCIDO', fecha: '2025-05-01', kwh: 50 },
        { serial: 'SN-HW0', fecha: '2099-01-01', kwh: 50 },
        { serial: 'SN-HW0', fecha: '2025-05-03', kwh: -10 },
      ],
    };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-03' })
      .expect(200);

    expect(respuesta.body.datos.insertadas).toBe(1);
    expect(respuesta.body.datos.rechazadas).toBe(3);
    expect(respuesta.body.datos.estado).toBe('COMPLETADA_CON_ERRORES');
    expect(respuesta.body.datos.advertencias.join(' ')).toContain('SERIAL-DESCONOCIDO');
  });

  it('omite los periodos cerrados durante la sincronizacion', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, mes: 5, costo_kwh: 1.0, aprobarInmediato: true })
      .expect(201);
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/close`)
      .send({ anio: 2025, mes: 5, motivo: 'Cierre contable' })
      .expect(200);

    comportamiento = {
      tipo: 'EXITO',
      registros: [{ serial: 'SN-HW0', fecha: '2025-05-10', kwh: 100 }],
    };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-10', hasta: '2025-05-10' })
      .expect(200);

    expect(respuesta.body.datos.rechazadas).toBe(1);
    expect(respuesta.body.datos.advertencias.join(' ')).toContain('cerrado');
    expect(await filasProduccion(datos.idProyecto)).toHaveLength(0);
  });

  it('valida el rango solicitado antes de contactar al servicio', async () => {
    const invertido = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-10', hasta: '2025-05-01' })
      .expect(422);
    expect(invertido.body.error.mensaje).toContain('posterior a la fecha final');

    const futuro = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2099-01-01', hasta: '2099-01-02' })
      .expect(422);
    expect(futuro.body.error.mensaje).toContain('fechas futuras');
  });

  it('exige que la integracion este activa', async () => {
    await execute("UPDATE apis_fabricante SET estado = 'INACTIVA' WHERE id_api = ?", [datos.idApi]);
    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(409);
    expect(respuesta.body.error.mensaje).toContain('no esta activa');
  });

  it('informa cuando no hay inversores Huawei asociados', async () => {
    await execute("UPDATE inversores SET tipo_conexion = 'MANUAL', id_api = NULL WHERE id_proyecto = ?", [
      datos.idProyecto,
    ]);
    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(409);
    expect(respuesta.body.error.mensaje).toContain('No hay inversores');
  });

  // -------------------------------------------------------------------------
  // Errores diferenciados del adaptador
  // -------------------------------------------------------------------------

  it('traduce el error de credenciales invalidas y registra la ejecucion fallida', async () => {
    comportamiento = {
      tipo: 'ERROR',
      codigo: 'CREDENCIALES_INVALIDAS',
      estado: 401,
      mensaje: 'Usuario o systemCode invalidos.',
    };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(401);

    expect(respuesta.body.error.codigo).toBe('CREDENCIALES_INVALIDAS');
    expect(respuesta.body.error.mensaje).toContain('credenciales');

    const ejecucion = await queryOne<{ estado: string; codigo_error: string }>(
      'SELECT estado, codigo_error FROM sincronizaciones ORDER BY id_sync DESC LIMIT 1',
    );
    expect(ejecucion?.estado).toBe('FALLIDA');
    expect(ejecucion?.codigo_error).toBe('CREDENCIALES_INVALIDAS');
  });

  it('traduce el error de IP no autorizada', async () => {
    comportamiento = {
      tipo: 'ERROR',
      codigo: 'IP_NO_AUTORIZADA',
      estado: 403,
      mensaje: 'La IP de origen no esta autorizada.',
    };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(403);

    expect(respuesta.body.error.codigo).toBe('IP_NO_AUTORIZADA');
    expect(respuesta.body.error.mensaje).toContain('IP publica del servidor');
  });

  it('traduce el limite de consultas del fabricante', async () => {
    comportamiento = { tipo: 'ERROR', codigo: 'LIMITE_API', estado: 429, mensaje: 'Limite alcanzado.' };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(429);

    expect(respuesta.body.error.codigo).toBe('LIMITE_API');
  });

  it('aborta por tiempo de espera agotado sin dejar datos a medias', async () => {
    comportamiento = { tipo: 'TIMEOUT' };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(504);

    expect(respuesta.body.error.codigo).toBe('TIEMPO_AGOTADO');
    expect(await filasProduccion(datos.idProyecto)).toHaveLength(0);

    const ejecucion = await queryOne<{ estado: string; codigo_error: string }>(
      'SELECT estado, codigo_error FROM sincronizaciones ORDER BY id_sync DESC LIMIT 1',
    );
    expect(ejecucion?.estado).toBe('FALLIDA');
    expect(ejecucion?.codigo_error).toBe('TIEMPO_AGOTADO');
  }, 30000);

  // -------------------------------------------------------------------------
  // Concurrencia, configuracion y consulta de ejecuciones
  // -------------------------------------------------------------------------

  it('libera el bloqueo de concurrencia al terminar', async () => {
    comportamiento = { tipo: 'EXITO', registros: [{ serial: 'SN-HW0', fecha: '2025-05-01', kwh: 10 }] };

    await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(200);

    const bloqueos = await query('SELECT recurso FROM bloqueos');
    expect(bloqueos).toHaveLength(0);
  });

  it('nunca expone credenciales al consultar la configuracion', async () => {
    const respuesta = await comoUsuario(admin).get('/api/integrations/huawei/config').expect(200);
    const cuerpo = JSON.stringify(respuesta.body);

    expect(cuerpo).not.toContain('systemCode');
    expect(cuerpo).not.toContain('password');
    expect(respuesta.body.meta.pasosParaActivarReal.length).toBeGreaterThan(0);
    expect(respuesta.body.meta.advertenciaMock).toContain('SIMULADO');
  });

  it('exige la IP autorizada antes de activar el modo real', async () => {
    const respuesta = await comoUsuario(admin)
      .put(`/api/integrations/huawei/config/${datos.idApi}`)
      .send({ modo: 'REAL' })
      .expect(409);

    expect(respuesta.body.error.mensaje).toContain('IP publica autorizada');
  });

  it('prueba la conexion y guarda el resultado en la configuracion', async () => {
    comportamiento = { tipo: 'EXITO', registros: [] };

    const respuesta = await comoUsuario(operativo)
      .post('/api/integrations/huawei/test')
      .send({ id_api: datos.idApi })
      .expect(200);

    expect(respuesta.body.datos.ok).toBe(true);

    const api = await queryOne<{ resultado_ultima_prueba: string; ultima_prueba: string }>(
      'SELECT resultado_ultima_prueba, ultima_prueba FROM apis_fabricante WHERE id_api = ?',
      [datos.idApi],
    );
    expect(api?.resultado_ultima_prueba).toContain('OK');
    expect(api?.ultima_prueba).toBeTruthy();
  });

  it('lista las ejecuciones con su detalle', async () => {
    comportamiento = { tipo: 'EXITO', registros: [{ serial: 'SN-HW0', fecha: '2025-05-01', kwh: 10 }] };
    await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(200);

    const lista = await comoUsuario(gerencial === undefined ? operativo : operativo)
      .get('/api/integrations/huawei/runs')
      .expect(200);

    expect(lista.body.datos.length).toBeGreaterThan(0);
    expect(lista.body.datos[0].modo).toBe('MOCK');
    expect(lista.body.meta.total).toBeGreaterThan(0);
  });

  it('el usuario gerencial no puede ejecutar sincronizaciones', async () => {
    await comoUsuario(gerencial)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: datos.idApi, desde: '2025-05-01', hasta: '2025-05-01' })
      .expect(403);
  });
});
