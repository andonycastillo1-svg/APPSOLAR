import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  iniciarSesion,
  levantarPythonSimulado,
  prepararBaseDeDatos,
  type ComportamientoPython,
  type Sesion,
} from '../utils/entorno';
import { env } from '../../src/config/env';
import { query, queryOne } from '../../src/db/pool';

/**
 * Recorrido de punta a punta exigido en el alcance:
 *
 *  1. Un administrador crea usuario, cliente, proyecto (PPA) e inversor.
 *  2. Registra la proyeccion mensual del proyecto.
 *  3. Un coordinador con `tarifas.gestionar` registra las tarifas y el
 *     administrador las aprueba.
 *  4. Un operativo carga el formato historico del Excel, con dos filas del
 *     mismo mes, y ejecuta ademas una sincronizacion Huawei simulada.
 *  5. El sistema controla los niveles de detalle sin perder ni duplicar datos,
 *     aplica la tarifa de cada periodo y calcula el valor en quetzales.
 *  6. Un usuario gerencial compara proyeccion, anio anterior y anio
 *     seleccionado, consulta el cumplimiento y genera un reporte imprimible.
 *  7. Todas las acciones relevantes quedan protegidas por rol y auditadas.
 */
describe('Recorrido completo de punta a punta', () => {
  let admin: Sesion;
  let coordinador: Sesion;
  let operativo: Sesion;
  let gerencial: Sesion;

  let idCliente = 0;
  let idProyectoPpa = 0;
  let idProyectoEpc = 0;
  let idInversorHuawei = 0;
  let idApi = 0;
  let nombrePlantaEpc = '';

  let cerrarStub: () => Promise<void>;
  let comportamiento: ComportamientoPython = { tipo: 'EXITO', registros: [] };
  const urlOriginal = env.python.url;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    admin = await iniciarSesion(env.bootstrap.adminEmail, env.bootstrap.adminPassword);

    const stub = await levantarPythonSimulado(() => comportamiento);
    cerrarStub = stub.cerrar;
    env.python.url = stub.url;
  }, 180000);

  afterAll(async () => {
    env.python.url = urlOriginal;
    await cerrarStub();
    await cerrarTodo();
  });

  // -------------------------------------------------------------------------

  it('1. el administrador crea los usuarios operativo, coordinador y gerencial', async () => {
    const definiciones = [
      { nombre: 'Operativo E2E', email: 'e2e.operativo@retse.com.gt', rol: 'OPERATIVO' },
      { nombre: 'Coordinador E2E', email: 'e2e.coordinador@retse.com.gt', rol: 'OPERATIVO' },
      { nombre: 'Gerencia E2E', email: 'e2e.gerencia@retse.com.gt', rol: 'GERENCIAL' },
    ];

    const creados: Record<string, { id: number; password: string }> = {};

    for (const definicion of definiciones) {
      const respuesta = await comoUsuario(admin).post('/api/users').send(definicion).expect(201);
      expect(respuesta.body.datos.passwordTemporal).toBeTruthy();
      creados[definicion.email] = {
        id: respuesta.body.datos.id_usuario,
        password: respuesta.body.datos.passwordTemporal,
      };
    }

    // El coordinador recibe el permiso individual, no un cuarto rol global.
    const permisos = await comoUsuario(admin)
      .put(`/api/users/${creados['e2e.coordinador@retse.com.gt'].id}/permissions`)
      .send({ otorgados: ['tarifas.gestionar'], revocados: [] })
      .expect(200);
    expect(permisos.body.datos.permisosEfectivos).toContain('tarifas.gestionar');

    // Cada usuario debe cambiar su contrasena temporal en el primer ingreso.
    for (const [email, credencial] of Object.entries(creados)) {
      const sesion = await iniciarSesion(email, credencial.password);
      const perfil = await comoUsuario(sesion).get('/api/auth/me').expect(200);
      expect(perfil.body.datos.debeCambiarPassword).toBe(true);

      await comoUsuario(sesion)
        .post('/api/auth/change-password')
        .send({ passwordActual: credencial.password, passwordNueva: 'Recorrido.2026#E2E' })
        .expect(200);
    }

    operativo = await iniciarSesion('e2e.operativo@retse.com.gt', 'Recorrido.2026#E2E');
    coordinador = await iniciarSesion('e2e.coordinador@retse.com.gt', 'Recorrido.2026#E2E');
    gerencial = await iniciarSesion('e2e.gerencia@retse.com.gt', 'Recorrido.2026#E2E');

    expect(coordinador.usuario.permisos).toContain('tarifas.gestionar');
    expect(operativo.usuario.permisos).not.toContain('tarifas.gestionar');
  });

  it('2. crea el cliente, dos proyectos con modalidad PPA/EPC y sus inversores', async () => {
    const cliente = await comoUsuario(admin)
      .post('/api/clients')
      .send({ nombre: 'Cliente Recorrido, S.A.', nit: '55667788-9', ubicacion: 'Escuintla' })
      .expect(201);
    idCliente = cliente.body.datos.id_cliente;

    const ppa = await comoUsuario(admin)
      .post('/api/projects')
      .send({
        id_cliente: idCliente,
        nombre: 'Planta Recorrido PPA',
        tipo_proyecto: 'PPA',
        capacidad_kwp: 500,
        ubicacion: 'Escuintla',
      })
      .expect(201);
    idProyectoPpa = ppa.body.datos.id_proyecto;

    const epc = await comoUsuario(admin)
      .post('/api/projects')
      .send({
        id_cliente: idCliente,
        nombre: 'Planta Recorrido EPC',
        tipo_proyecto: 'EPC',
        capacidad_kwp: 300,
      })
      .expect(201);
    idProyectoEpc = epc.body.datos.id_proyecto;
    nombrePlantaEpc = 'Planta Recorrido EPC';

    // Un proyecto no puede existir sin cliente.
    await comoUsuario(admin)
      .post('/api/projects')
      .send({ id_cliente: 999999, nombre: 'Proyecto sin cliente', tipo_proyecto: 'PPA' })
      .expect(422);

    // La integracion Huawei del entorno de demostracion.
    const api = await queryOne<{ id_api: number }>(
      "SELECT id_api FROM apis_fabricante WHERE marca = 'HUAWEI' LIMIT 1",
    );
    if (api) {
      idApi = api.id_api;
    } else {
      const { execute } = await import('../../src/db/pool');
      const creada = await execute(
        `INSERT INTO apis_fabricante (marca, nombre, endpoint, modo, estado, timeout_s, max_reintentos)
         VALUES ('HUAWEI', 'Huawei Recorrido', 'http://127.0.0.1:9/thirdData', 'MOCK', 'ACTIVA', 20, 1)`,
      );
      idApi = creada.insertId;
    }

    // El operativo si puede registrar inversores.
    const inversor = await comoUsuario(operativo)
      .post('/api/inverters')
      .send({
        id_proyecto: idProyectoPpa,
        marca: 'Huawei',
        modelo: 'SUN2000-100KTL',
        tipo_conexion: 'HUAWEI_API',
        serial_externo: 'SN-E2E-001',
        estacion_externa: 'NE=E2E',
        capacidad_kwp: 500,
        id_api: idApi,
      })
      .expect(201);
    idInversorHuawei = inversor.body.datos.id_inversor;

    // Un inversor Huawei sin identificador externo se rechaza.
    await comoUsuario(operativo)
      .post('/api/inverters')
      .send({ id_proyecto: idProyectoPpa, marca: 'Huawei', modelo: 'X', tipo_conexion: 'HUAWEI_API' })
      .expect(422);
  });

  it('3. registra y aprueba la proyeccion mensual del proyecto PPA', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${idProyectoPpa}/projections`)
      .send({
        anio: 2025,
        aprobarInmediato: true,
        meses: Array.from({ length: 12 }, (_, i) => ({ mes: i + 1, proyeccion_kwh: 10000 })),
      })
      .expect(201);

    await comoUsuario(admin)
      .post(`/api/projects/${idProyectoPpa}/projections`)
      .send({
        anio: 2026,
        aprobarInmediato: true,
        meses: [
          { mes: 1, proyeccion_kwh: 12000 },
          { mes: 2, proyeccion_kwh: 12000 },
        ],
      })
      .expect(201);

    const calendario = await comoUsuario(gerencial)
      .get(`/api/projects/${idProyectoPpa}/projections?anio=2026`)
      .expect(200);
    expect(Number(calendario.body.datos.totales.proyeccion_kwh)).toBe(24000);
  });

  it('4. el coordinador registra las tarifas y el administrador las aprueba', async () => {
    // El operativo comun no puede registrar tarifas.
    await comoUsuario(operativo)
      .post(`/api/projects/${idProyectoPpa}/rates`)
      .send({ anio: 2026, mes: 1, costo_kwh: 1.1 })
      .expect(403);

    const tarifas: Array<{ proyecto: number; anio: number; mes: number; costo: number }> = [
      { proyecto: idProyectoPpa, anio: 2025, mes: 1, costo: 1.0 },
      { proyecto: idProyectoPpa, anio: 2026, mes: 1, costo: 1.2 },
      { proyecto: idProyectoPpa, anio: 2026, mes: 2, costo: 1.5 },
      { proyecto: idProyectoEpc, anio: 2025, mes: 1, costo: 0.9 },
      { proyecto: idProyectoEpc, anio: 2025, mes: 2, costo: 0.95 },
    ];

    for (const tarifa of tarifas) {
      const creada = await comoUsuario(coordinador)
        .post(`/api/projects/${tarifa.proyecto}/rates`)
        .send({ anio: tarifa.anio, mes: tarifa.mes, costo_kwh: tarifa.costo })
        .expect(201);
      expect(creada.body.datos.estado).toBe('BORRADOR');

      await comoUsuario(admin)
        .post(`/api/projects/${tarifa.proyecto}/rates/${creada.body.datos.id_tarifa}/approve`)
        .expect(200);
    }

    const calendario = await comoUsuario(coordinador)
      .get(`/api/projects/${idProyectoPpa}/rates?anio=2026`)
      .expect(200);
    expect(calendario.body.datos.resumen.mesesAprobados).toBe(2);
  });

  it('5. el operativo carga el formato historico del Excel con filas del mismo mes', async () => {
    const contenido = Buffer.from(
      [
        'Planta,Tipo,Anio,Mes,Generacion,Comentarios',
        `${nombrePlantaEpc},EPC,2025,Enero,8000,Medidor principal`,
        `${nombrePlantaEpc},EPC,2025,Enero,2000,Medidor secundario`,
        `${nombrePlantaEpc},EPC,2025,Febrero,9500,`,
        `${nombrePlantaEpc},EPC,2025,Trecemberre,100,Mes invalido a proposito`,
      ].join('\r\n'),
      'utf8',
    );

    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', contenido, 'historico_recorrido.csv')
      .expect(200);

    const p = previa.body.datos;
    expect(p.formato).toBe('HISTORICO_EXCEL');
    expect(p.totales.validas).toBe(3);
    expect(p.totales.errores).toBe(1);
    expect(p.gruposQueRequierenDecision).toHaveLength(1);
    expect(p.requiereConfirmarCargaParcial).toBe(true);

    const clave = p.gruposQueRequierenDecision[0].clave;

    const confirmacion = await comoUsuario(operativo)
      .post(`/api/imports/${p.id_historico}/confirm`)
      .send({ decisiones: { [clave]: 'SUMAR' }, aceptarCargaParcial: true })
      .expect(200);

    // Enero se consolido en un solo registro de 10000 kWh (8000 + 2000)
    // y febrero se cargo tal cual: no se perdio ni se duplico informacion.
    expect(confirmacion.body.datos.insertadas).toBe(2);

    const resumen = await comoUsuario(operativo)
      .get(`/api/production/summary?desde=2025-01-01&hasta=2025-02-28&id_proyecto=${idProyectoEpc}`)
      .expect(200);

    expect(Number(resumen.body.datos.kwh)).toBe(19500);
    // 10000 x 0.90 + 9500 x 0.95 = 9000 + 9025 = 18025
    expect(Number(resumen.body.datos.valor_q)).toBe(18025);
    expect(resumen.body.datos.coberturaTarifaria.completa).toBe(true);
  });

  it('6. el operativo ejecuta una sincronizacion Huawei simulada e idempotente', async () => {
    comportamiento = {
      tipo: 'EXITO',
      registros: [
        { serial: 'SN-E2E-001', fecha: '2026-01-10', kwh: 400 },
        { serial: 'SN-E2E-001', fecha: '2026-01-11', kwh: 450 },
        { serial: 'SN-E2E-001', fecha: '2026-02-10', kwh: 380 },
      ],
    };

    const primera = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: idApi, desde: '2026-01-10', hasta: '2026-02-10', granularidad: 'DIARIA' })
      .expect(200);

    expect(primera.body.datos.insertadas).toBe(3);
    expect(primera.body.datos.esSimulado).toBe(true);

    const segunda = await comoUsuario(operativo)
      .post('/api/integrations/huawei/sync')
      .send({ id_api: idApi, desde: '2026-01-10', hasta: '2026-02-10', granularidad: 'DIARIA' })
      .expect(200);
    expect(segunda.body.datos.insertadas).toBe(0);
    expect(segunda.body.datos.actualizadas).toBe(3);

    const resumen = await comoUsuario(operativo)
      .get(`/api/production/summary?desde=2026-01-01&hasta=2026-02-28&id_proyecto=${idProyectoPpa}`)
      .expect(200);

    // (400 + 450) x 1.2 + 380 x 1.5 = 1020 + 570 = 1590
    expect(Number(resumen.body.datos.kwh)).toBe(1230);
    expect(Number(resumen.body.datos.valor_q)).toBe(1590);
  });

  it('7. el gerencial compara proyeccion, anio anterior y anio seleccionado', async () => {
    const anual = await comoUsuario(gerencial)
      .get(`/api/production/annual-summary?anio=2026&id_proyecto=${idProyectoPpa}`)
      .expect(200);

    const enero = anual.body.datos.filas[0];
    expect(Number(enero.proyeccion_kwh)).toBe(12000);
    expect(Number(enero.generacion_anio_seleccionado)).toBe(850);
    expect(Number(enero.generacion_anio_anterior)).toBe(0);
    expect(Number(enero.cumplimiento_anio_seleccionado)).toBeCloseTo(7.08, 1);
    expect(Number(enero.tarifa_q_kwh)).toBe(1.2);
    expect(Number(enero.valor_producido_q)).toBe(1020);

    const totales = anual.body.datos.totales;
    expect(Number(totales.generacion_anio_seleccionado)).toBe(1230);
    expect(Number(totales.valor_producido_q)).toBe(1590);
  });

  it('8. el gerencial genera un reporte imprimible y lo exporta', async () => {
    const reporte = await comoUsuario(gerencial)
      .post('/api/reports/generate')
      .send({
        tipo: 'RESUMEN_ANUAL',
        nombre: 'Reporte gerencial del recorrido',
        desde: '2026-01-01',
        hasta: '2026-02-28',
        id_proyecto: idProyectoPpa,
        granularidad: 'MENSUAL',
        anio: 2026,
        guardar: true,
      })
      .expect(201);

    expect(reporte.body.datos.cobertura.completa).toBe(true);
    expect(reporte.body.datos.advertenciaOficial).toBeNull();
    expect(reporte.body.datos.contexto.modalidad).toBe('PPA');

    const pdf = await comoUsuario(gerencial)
      .get(`/api/reports/${reporte.body.datos.id_reporte}/export?formato=pdf`)
      .expect(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('9. el gerencial nunca puede modificar datos', async () => {
    await comoUsuario(gerencial).post('/api/clients').send({ nombre: 'X', nit: '1-1' }).expect(403);
    await comoUsuario(gerencial)
      .post('/api/production')
      .send({ id_proyecto: idProyectoPpa, fecha: '2026-01-01', kwh: 1 })
      .expect(403);
    await comoUsuario(gerencial).get('/api/audit').expect(403);
  });

  it('10. todas las acciones relevantes quedaron registradas en la auditoria', async () => {
    const acciones = await query<{ accion: string; total: number }>(
      'SELECT accion, COUNT(*) AS total FROM auditoria GROUP BY accion',
    );
    const mapa = new Map(acciones.map((a) => [a.accion, Number(a.total)]));

    for (const accion of [
      'INICIO_SESION',
      'USUARIO_CREADO',
      'PERMISOS_ACTUALIZADOS',
      'CAMBIO_PASSWORD',
      'CLIENTE_CREADO',
      'PROYECTO_CREADO',
      'INVERSOR_CREADO',
      'PROYECCION_REGISTRADA',
      'TARIFA_CREADA',
      'TARIFA_APROBADA',
      'IMPORTACION_PREVISUALIZADA',
      'IMPORTACION_CONFIRMADA',
      'SINCRONIZACION_EJECUTADA',
      'REPORTE_GENERADO',
      'REPORTE_EXPORTADO',
    ]) {
      expect(mapa.get(accion) ?? 0, `Falta auditoria de ${accion}`).toBeGreaterThan(0);
    }

    // La auditoria nunca contiene contrasenas ni secretos.
    const cuerpos = await query<{ contenido: string | null }>(
      `SELECT CONCAT(COALESCE(CAST(datos_antes AS CHAR), ''), COALESCE(CAST(datos_despues AS CHAR), '')) AS contenido
         FROM auditoria`,
    );
    const todo = cuerpos.map((c) => c.contenido ?? '').join(' ');
    expect(todo).not.toContain('Recorrido.2026#E2E');
    expect(todo).not.toContain('password_hash');
  });

  it('11. el estado del sistema refleja los datos cargados', async () => {
    const salud = await comoUsuario(admin).get('/api/health/detalle');
    expect([200, 503]).toContain(salud.status);
    expect(salud.body.datos.mysql.estado).toBe('operativo');
    expect(salud.body.datos.integracionHuawei.simulado).toBe(true);
    expect(salud.body.datos.ultimaImportacion).toBeTruthy();
    expect(salud.body.datos.ultimaSincronizacion).toBeTruthy();
  });
});
