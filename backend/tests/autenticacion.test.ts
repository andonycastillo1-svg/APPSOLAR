import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cerrarTodo,
  comoUsuario,
  crearUsuario,
  iniciarSesion,
  obtenerApp,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
} from './utils/entorno';
import { execute, queryOne } from '../src/db/pool';

describe('Autenticacion y sesiones', () => {
  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('operativo.auth@retse.com.gt', 'OPERATIVO');
    await crearUsuario('inactivo.auth@retse.com.gt', 'OPERATIVO');
    await execute('UPDATE usuarios SET activo = 0 WHERE email = ?', ['inactivo.auth@retse.com.gt']);
  }, 120000);

  afterAll(async () => {
    await cerrarTodo();
  });

  it('permite iniciar sesion con credenciales validas y entrega cookies HttpOnly', async () => {
    const respuesta = await request(obtenerApp())
      .post('/api/auth/login')
      .send({ email: 'operativo.auth@retse.com.gt', password: PASSWORD_PRUEBAS })
      .expect(200);

    expect(respuesta.body.ok).toBe(true);
    expect(respuesta.body.datos.usuario.rol).toBe('OPERATIVO');

    const cookies = (respuesta.headers['set-cookie'] as unknown as string[]) ?? [];
    const acceso = cookies.find((c) => c.startsWith('as_acceso='));
    const refresco = cookies.find((c) => c.startsWith('as_refresco='));
    const csrf = cookies.find((c) => c.startsWith('as_csrf='));

    expect(acceso).toContain('HttpOnly');
    expect(refresco).toContain('HttpOnly');
    // El token CSRF debe ser legible por el frontend (patron double submit).
    expect(csrf).not.toContain('HttpOnly');

    // El token de acceso jamas viaja en el cuerpo de la respuesta.
    expect(JSON.stringify(respuesta.body)).not.toContain('as_acceso');
  });

  it('rechaza credenciales invalidas sin revelar si el correo existe', async () => {
    const inexistente = await request(obtenerApp())
      .post('/api/auth/login')
      .send({ email: 'no.existe@retse.com.gt', password: 'Cualquiera.2026#X' })
      .expect(401);

    const existente = await request(obtenerApp())
      .post('/api/auth/login')
      .send({ email: 'operativo.auth@retse.com.gt', password: 'Incorrecta.2026#X' })
      .expect(401);

    expect(inexistente.body.error.mensaje).toBe(existente.body.error.mensaje);
    expect(existente.body.error.mensaje).toContain('incorrectos');
  });

  it('impide el acceso de un usuario desactivado', async () => {
    const respuesta = await request(obtenerApp())
      .post('/api/auth/login')
      .send({ email: 'inactivo.auth@retse.com.gt', password: PASSWORD_PRUEBAS })
      .expect(401);

    expect(respuesta.body.error.mensaje).toContain('desactivado');
  });

  it('bloquea temporalmente tras superar los intentos fallidos permitidos', async () => {
    await crearUsuario('bloqueo.auth@retse.com.gt', 'OPERATIVO');

    for (let intento = 0; intento < 5; intento += 1) {
      await request(obtenerApp())
        .post('/api/auth/login')
        .send({ email: 'bloqueo.auth@retse.com.gt', password: 'Mala.2026#Clave' })
        .expect(401);
    }

    // Con la contrasena correcta tambien se rechaza mientras dure el bloqueo.
    const respuesta = await request(obtenerApp())
      .post('/api/auth/login')
      .send({ email: 'bloqueo.auth@retse.com.gt', password: PASSWORD_PRUEBAS })
      .expect(429);

    expect(respuesta.body.error.codigo).toBe('USUARIO_BLOQUEADO');

    const fila = await queryOne<{ intentos_fallidos: number }>(
      'SELECT intentos_fallidos FROM usuarios WHERE email = ?',
      ['bloqueo.auth@retse.com.gt'],
    );
    expect(Number(fila?.intentos_fallidos)).toBeGreaterThanOrEqual(5);
  });

  it('registra en auditoria los inicios de sesion exitosos y fallidos', async () => {
    const exitos = await queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM auditoria WHERE accion = 'INICIO_SESION'",
    );
    const fallos = await queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM auditoria WHERE accion = 'AUTENTICACION_FALLIDA'",
    );

    expect(Number(exitos?.total)).toBeGreaterThan(0);
    expect(Number(fallos?.total)).toBeGreaterThan(0);

    // La auditoria nunca guarda la contrasena utilizada.
    const registros = await queryOne<{ datos: string | null }>(
      "SELECT CAST(datos_despues AS CHAR) AS datos FROM auditoria WHERE accion = 'INICIO_SESION' LIMIT 1",
    );
    expect(registros?.datos ?? '').not.toContain(PASSWORD_PRUEBAS);
  });

  it('devuelve el perfil autenticado con sus permisos efectivos', async () => {
    const sesion = await iniciarSesion('operativo.auth@retse.com.gt', PASSWORD_PRUEBAS);
    const respuesta = await comoUsuario(sesion).get('/api/auth/me').expect(200);

    expect(respuesta.body.datos.usuario.email).toBe('operativo.auth@retse.com.gt');
    expect(respuesta.body.datos.usuario.permisos).toContain('produccion.ver');
    expect(respuesta.body.datos.usuario.permisos).not.toContain('usuarios.gestionar');
  });

  it('rechaza el acceso sin sesion con 401', async () => {
    const respuesta = await request(obtenerApp()).get('/api/production/summary').expect(401);
    expect(respuesta.body.error.codigo).toBe('NO_AUTENTICADO');
  });

  it('renueva la sesion rotando el refresh token e invalida el anterior', async () => {
    const sesion = await iniciarSesion('operativo.auth@retse.com.gt', PASSWORD_PRUEBAS);

    const renovacion = await request(obtenerApp())
      .post('/api/auth/refresh')
      .set('Cookie', sesion.cookies)
      .set('x-csrf-token', sesion.csrf)
      .expect(200);

    expect(renovacion.body.datos.usuario.email).toBe('operativo.auth@retse.com.gt');

    // Reusar el refresh token anterior debe fallar: se detecta el reuso.
    await request(obtenerApp())
      .post('/api/auth/refresh')
      .set('Cookie', sesion.cookies)
      .set('x-csrf-token', sesion.csrf)
      .expect(401);
  });

  it('cierra la sesion y revoca el token de refresco', async () => {
    const sesion = await iniciarSesion('operativo.auth@retse.com.gt', PASSWORD_PRUEBAS);
    await comoUsuario(sesion).post('/api/auth/logout').expect(200);

    await request(obtenerApp())
      .post('/api/auth/refresh')
      .set('Cookie', sesion.cookies)
      .set('x-csrf-token', sesion.csrf)
      .expect(401);
  });

  it('exige el token CSRF en las operaciones que modifican estado', async () => {
    const sesion = await iniciarSesion('operativo.auth@retse.com.gt', PASSWORD_PRUEBAS);

    const respuesta = await request(obtenerApp())
      .post('/api/production')
      .set('Cookie', sesion.cookies)
      .send({ id_proyecto: 1, fecha: '2026-01-01', kwh: 10 })
      .expect(400);

    expect(respuesta.body.error.codigo).toBe('SOLICITUD_INVALIDA');
    expect(respuesta.body.error.mensaje).toContain('token de seguridad');
  });

  it('valida la politica de contrasenas al cambiarla y revoca las demas sesiones', async () => {
    await crearUsuario('cambio.auth@retse.com.gt', 'OPERATIVO');
    const sesion = await iniciarSesion('cambio.auth@retse.com.gt', PASSWORD_PRUEBAS);

    const debil = await comoUsuario(sesion)
      .post('/api/auth/change-password')
      .send({ passwordActual: PASSWORD_PRUEBAS, passwordNueva: 'corta' })
      .expect(422);
    expect(debil.body.error.detalles.requisitos.length).toBeGreaterThan(0);

    const incorrecta = await comoUsuario(sesion)
      .post('/api/auth/change-password')
      .send({ passwordActual: 'NoEsLaActual.2026#', passwordNueva: 'Nueva.2026#Clave' })
      .expect(422);
    expect(incorrecta.body.error.mensaje).toContain('actual no es correcta');

    await comoUsuario(sesion)
      .post('/api/auth/change-password')
      .send({ passwordActual: PASSWORD_PRUEBAS, passwordNueva: 'Nueva.2026#Clave' })
      .expect(200);

    // La contrasena anterior deja de funcionar y la nueva si.
    await request(obtenerApp())
      .post('/api/auth/login')
      .send({ email: 'cambio.auth@retse.com.gt', password: PASSWORD_PRUEBAS })
      .expect(401);

    await request(obtenerApp())
      .post('/api/auth/login')
      .send({ email: 'cambio.auth@retse.com.gt', password: 'Nueva.2026#Clave' })
      .expect(200);
  });

  it('expone el estado de salud publico sin exigir autenticacion', async () => {
    const respuesta = await request(obtenerApp()).get('/health').expect(200);
    expect(respuesta.body.datos.estado).toBe('operativo');
    // La version publica no revela detalles internos.
    expect(respuesta.body.datos).not.toHaveProperty('mysql');
  });
});
