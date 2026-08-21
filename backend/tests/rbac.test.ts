import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearUsuario,
  iniciarSesion,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { query } from '../src/db/pool';
import { PERMISOS_POR_ROL, TODOS_LOS_PERMISOS } from '../src/config/permisos';

/**
 * Matriz RBAC: cada rol solo puede ejecutar lo autorizado.
 * La verificacion ocurre SIEMPRE en el servidor.
 */
describe('Control de acceso basado en roles', () => {
  let admin: Sesion;
  let operativo: Sesion;
  let coordinador: Sesion;
  let gerencial: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();

    await crearUsuario('rbac.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('rbac.operativo@retse.com.gt', 'OPERATIVO');
    // El coordinador es OPERATIVO con el permiso individual `tarifas.gestionar`.
    await crearUsuario('rbac.coordinador@retse.com.gt', 'OPERATIVO', ['tarifas.gestionar']);
    await crearUsuario('rbac.gerencial@retse.com.gt', 'GERENCIAL');

    admin = await iniciarSesion('rbac.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('rbac.operativo@retse.com.gt', PASSWORD_PRUEBAS);
    coordinador = await iniciarSesion('rbac.coordinador@retse.com.gt', PASSWORD_PRUEBAS);
    gerencial = await iniciarSesion('rbac.gerencial@retse.com.gt', PASSWORD_PRUEBAS);

    datos = await crearDatosBase();
  }, 120000);

  afterAll(async () => {
    await cerrarTodo();
  });

  it('el catalogo de permisos del codigo coincide con el de la base de datos', async () => {
    const filas = await query<{ codigo: string }>('SELECT codigo FROM permisos ORDER BY codigo');
    const enBase = filas.map((f) => f.codigo).sort();
    expect(enBase).toEqual([...TODOS_LOS_PERMISOS].sort());
  });

  it('la matriz de permisos por rol del codigo coincide con la de la base de datos', async () => {
    for (const rol of ['ADMINISTRATIVO', 'OPERATIVO', 'GERENCIAL'] as const) {
      const filas = await query<{ codigo: string }>(
        `SELECT p.codigo FROM roles r
           JOIN rol_permisos rp ON rp.id_rol = r.id_rol
           JOIN permisos p ON p.id_permiso = rp.id_permiso
          WHERE r.codigo = ? ORDER BY p.codigo`,
        [rol],
      );
      expect(filas.map((f) => f.codigo).sort()).toEqual([...PERMISOS_POR_ROL[rol]].sort());
    }
  });

  it('el usuario operativo NO recibe tarifas.gestionar por su rol', () => {
    expect(operativo.usuario.permisos).not.toContain('tarifas.gestionar');
    expect(coordinador.usuario.permisos).toContain('tarifas.gestionar');
  });

  it('el usuario gerencial es estrictamente de solo lectura', () => {
    const escritura = gerencial.usuario.permisos.filter((p) => !p.endsWith('.ver') && !p.startsWith('reportes.'));
    expect(escritura).toEqual([]);
  });

  describe('acceso permitido y denegado por rol', () => {
    const casos: Array<{
      descripcion: string;
      ejecutar: (sesion: Sesion, datos: DatosBase) => Promise<{ status: number }>;
      esperado: { admin: number; operativo: number; coordinador: number; gerencial: number };
    }> = [
      {
        descripcion: 'consultar el tablero',
        ejecutar: (s) => comoUsuario(s).get('/api/dashboard?desde=2026-01-01&hasta=2026-12-31'),
        esperado: { admin: 200, operativo: 200, coordinador: 200, gerencial: 200 },
      },
      {
        descripcion: 'listar usuarios',
        ejecutar: (s) => comoUsuario(s).get('/api/users'),
        esperado: { admin: 200, operativo: 403, coordinador: 403, gerencial: 403 },
      },
      {
        descripcion: 'crear un cliente',
        ejecutar: (s) =>
          comoUsuario(s)
            .post('/api/clients')
            .send({ nombre: `Cliente RBAC ${Math.random()}`, nit: `${Math.floor(Math.random() * 9999999)}-1` }),
        esperado: { admin: 201, operativo: 403, coordinador: 403, gerencial: 403 },
      },
      {
        descripcion: 'crear un proyecto',
        ejecutar: (s, d) =>
          comoUsuario(s)
            .post('/api/projects')
            .send({ id_cliente: d.idCliente, nombre: `Proyecto RBAC ${Math.random()}`, tipo_proyecto: 'PPA' }),
        esperado: { admin: 201, operativo: 403, coordinador: 403, gerencial: 403 },
      },
      {
        descripcion: 'crear un inversor',
        ejecutar: (s, d) =>
          comoUsuario(s)
            .post('/api/inverters')
            .send({ id_proyecto: d.idProyecto, marca: 'SMA', modelo: `M-${Math.random()}` }),
        esperado: { admin: 201, operativo: 201, coordinador: 201, gerencial: 403 },
      },
      {
        descripcion: 'registrar una tarifa mensual',
        ejecutar: (s, d) =>
          comoUsuario(s)
            .post(`/api/projects/${d.idProyecto}/rates`)
            .send({ anio: 2030, mes: Math.floor(Math.random() * 12) + 1, costo_kwh: 1.1 }),
        esperado: { admin: 201, operativo: 403, coordinador: 201, gerencial: 403 },
      },
      {
        descripcion: 'consultar el calendario de tarifas',
        ejecutar: (s, d) => comoUsuario(s).get(`/api/projects/${d.idProyecto}/rates?anio=2026`),
        esperado: { admin: 200, operativo: 200, coordinador: 200, gerencial: 200 },
      },
      {
        descripcion: 'registrar produccion manual',
        ejecutar: (s, d) =>
          comoUsuario(s)
            .post('/api/production')
            .send({
              id_proyecto: d.idProyecto,
              id_inversor: d.idInversor,
              fecha: `2026-03-${String(Math.floor(Math.random() * 27) + 1).padStart(2, '0')}`,
              kwh: 100,
            }),
        esperado: { admin: 201, operativo: 201, coordinador: 201, gerencial: 403 },
      },
      {
        descripcion: 'consultar el historial de importaciones',
        ejecutar: (s) => comoUsuario(s).get('/api/imports'),
        esperado: { admin: 200, operativo: 200, coordinador: 200, gerencial: 200 },
      },
      {
        descripcion: 'ejecutar una sincronizacion Huawei',
        ejecutar: (s, d) =>
          comoUsuario(s)
            .post('/api/integrations/huawei/sync')
            .send({ id_api: d.idApi, desde: '2026-01-01', hasta: '2026-01-02' }),
        // El gerencial recibe 403; los demas superan la autorizacion (el
        // resultado posterior depende del servicio de integracion).
        esperado: { admin: -1, operativo: -1, coordinador: -1, gerencial: 403 },
      },
      {
        descripcion: 'configurar la integracion Huawei',
        ejecutar: (s, d) =>
          comoUsuario(s).put(`/api/integrations/huawei/config/${d.idApi}`).send({ timeout_s: 30 }),
        esperado: { admin: 200, operativo: 403, coordinador: 403, gerencial: 403 },
      },
      {
        descripcion: 'consultar la auditoria',
        ejecutar: (s) => comoUsuario(s).get('/api/audit'),
        esperado: { admin: 200, operativo: 403, coordinador: 403, gerencial: 403 },
      },
      {
        descripcion: 'consultar la configuracion',
        ejecutar: (s) => comoUsuario(s).get('/api/config'),
        esperado: { admin: 200, operativo: 403, coordinador: 403, gerencial: 403 },
      },
      {
        descripcion: 'generar un reporte',
        ejecutar: (s) =>
          comoUsuario(s)
            .post('/api/reports/generate')
            .send({ tipo: 'PRODUCCION', desde: '2026-01-01', hasta: '2026-03-31', guardar: false }),
        esperado: { admin: 201, operativo: 201, coordinador: 201, gerencial: 201 },
      },
      {
        descripcion: 'consultar el estado detallado de los servicios',
        ejecutar: (s) => comoUsuario(s).get('/api/health/detalle'),
        esperado: { admin: -2, operativo: 403, coordinador: 403, gerencial: 403 },
      },
    ];

    for (const caso of casos) {
      it(caso.descripcion, async () => {
        const sesiones = { admin, operativo, coordinador, gerencial };
        for (const [rol, esperado] of Object.entries(caso.esperado)) {
          const respuesta = await caso.ejecutar(sesiones[rol as keyof typeof sesiones], datos);
          if (esperado === -1) {
            // Solo se comprueba que la autorizacion no fue el motivo del rechazo.
            expect(respuesta.status, `${caso.descripcion} como ${rol}`).not.toBe(403);
          } else if (esperado === -2) {
            // El detalle de salud puede responder 200 u 503 segun los servicios.
            expect([200, 503], `${caso.descripcion} como ${rol}`).toContain(respuesta.status);
          } else {
            expect(respuesta.status, `${caso.descripcion} como ${rol}`).toBe(esperado);
          }
        }
      });
    }
  });

  it('el mensaje de denegacion identifica el permiso faltante', async () => {
    const respuesta = await comoUsuario(gerencial).get('/api/users').expect(403);
    expect(respuesta.body.error.codigo).toBe('SIN_PERMISO');
    expect(respuesta.body.error.detalles.permiso).toBe('usuarios.ver');
    expect(respuesta.body.error.mensaje).toContain('No cuenta con el permiso');
  });

  it('impide otorgar permisos de escritura a un usuario gerencial', async () => {
    const idGerencial = gerencial.usuario.id_usuario;
    const respuesta = await comoUsuario(admin)
      .put(`/api/users/${idGerencial}/permissions`)
      .send({ otorgados: ['produccion.registrar'], revocados: [] })
      .expect(409);

    expect(respuesta.body.error.mensaje).toContain('solo lectura');
  });

  it('permite otorgar y revocar permisos individuales a un usuario operativo', async () => {
    const idOperativo = operativo.usuario.id_usuario;

    const otorgado = await comoUsuario(admin)
      .put(`/api/users/${idOperativo}/permissions`)
      .send({ otorgados: ['tarifas.gestionar'], revocados: [] })
      .expect(200);
    expect(otorgado.body.datos.permisosEfectivos).toContain('tarifas.gestionar');

    const revocado = await comoUsuario(admin)
      .put(`/api/users/${idOperativo}/permissions`)
      .send({ otorgados: [], revocados: ['produccion.registrar'] })
      .expect(200);
    expect(revocado.body.datos.permisosEfectivos).not.toContain('produccion.registrar');
    expect(revocado.body.datos.permisosEfectivos).not.toContain('tarifas.gestionar');
  });

  it('impide que el ultimo administrador activo se desactive', async () => {
    const respuesta = await comoUsuario(admin)
      .put(`/api/users/${admin.usuario.id_usuario}`)
      .send({ activo: false });

    // Existe el administrador inicial, por lo que la regla que aplica es la de
    // no poder desactivar el propio usuario.
    expect(respuesta.status).toBe(409);
    expect(respuesta.body.error.mensaje).toMatch(/propio usuario|administrativos activos/);
  });
});
