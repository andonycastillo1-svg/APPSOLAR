import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
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
import { env } from '../src/config/env';
import { query, queryOne } from '../src/db/pool';
import { neutralizarFormula } from '../src/services/archivos';
import { sanitizar } from '../src/services/auditoria';

describe('Seguridad de la aplicacion', () => {
  let admin: Sesion;
  let operativo: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('seg.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('seg.oper@retse.com.gt', 'OPERATIVO');
    admin = await iniciarSesion('seg.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('seg.oper@retse.com.gt', PASSWORD_PRUEBAS);
    await limpiarDatos();
    datos = await crearDatosBase();
  }, 120000);

  afterAll(async () => {
    await cerrarTodo();
  });

  // -------------------------------------------------------------------------
  // Inyeccion
  // -------------------------------------------------------------------------

  it('resiste intentos de inyeccion SQL en los filtros de busqueda', async () => {
    const cargas = [
      "'; DROP TABLE usuarios; --",
      "' OR '1'='1",
      "1; DELETE FROM produccion WHERE 1=1; --",
      "\\'; SELECT SLEEP(5); --",
    ];

    for (const carga of cargas) {
      const respuesta = await comoUsuario(admin)
        .get('/api/clients')
        .query({ buscar: carga })
        .expect(200);
      expect(respuesta.body.ok).toBe(true);
    }

    // Las tablas siguen existiendo y con datos.
    const usuarios = await query('SELECT id_usuario FROM usuarios');
    expect(usuarios.length).toBeGreaterThan(0);
  });

  it('ignora los campos de ordenamiento no permitidos en lugar de interpolarlos', async () => {
    const respuesta = await comoUsuario(admin)
      .get('/api/clients')
      .query({ orden: 'nombre; DROP TABLE clientes', direccion: 'asc' })
      .expect(200);

    expect(respuesta.body.ok).toBe(true);
    const clientes = await query('SELECT id_cliente FROM clientes');
    expect(clientes.length).toBeGreaterThan(0);
  });

  it('almacena sin ejecutar el contenido con etiquetas HTML o scripts', async () => {
    const payload = '<script>alert("xss")</script>';
    const creado = await comoUsuario(admin)
      .post('/api/clients')
      .send({ nombre: `Cliente ${payload}`, nit: '11223344-5' })
      .expect(201);

    const cliente = await queryOne<{ nombre: string }>(
      'SELECT nombre FROM clientes WHERE id_cliente = ?',
      [creado.body.datos.id_cliente],
    );

    // El dato se guarda tal cual (sin corromperlo) y la API lo devuelve como
    // JSON: la neutralizacion final ocurre al renderizar en React.
    expect(cliente?.nombre).toContain(payload);

    const respuesta = await comoUsuario(admin).get('/api/clients').expect(200);
    expect(respuesta.headers['content-type']).toContain('application/json');
    expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
  });

  it('neutraliza la inyeccion de formulas al leer archivos CSV', () => {
    expect(neutralizarFormula('=1+1')).toBe("'=1+1");
    expect(neutralizarFormula('+cmd|calc')).toBe("'+cmd|calc");
    expect(neutralizarFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizarFormula('-2+3')).toBe("'-2+3");
    expect(neutralizarFormula('texto normal')).toBe('texto normal');
  });

  // -------------------------------------------------------------------------
  // Archivos
  // -------------------------------------------------------------------------

  it('nunca confia en el nombre del archivo enviado por el navegador', async () => {
    const contenido = Buffer.from('Planta,Tipo,Anio,Mes,Generacion,Comentarios\r\nX,PPA,2025,Enero,1,\r\n');

    const respuesta = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', contenido, '../../../../etc/passwd.csv')
      .expect(200);

    const historico = await queryOne<{ nombre_archivo_seguro: string; nombre_archivo_original: string }>(
      'SELECT nombre_archivo_seguro, nombre_archivo_original FROM historicos WHERE id_historico = ?',
      [respuesta.body.datos.id_historico],
    );

    // El nombre almacenado lo genera el servidor y no contiene rutas.
    expect(historico?.nombre_archivo_seguro).not.toContain('..');
    expect(historico?.nombre_archivo_seguro).not.toContain('/');
    expect(historico?.nombre_archivo_seguro).toMatch(/^\d+_[0-9a-f]{16}\.csv$/);
    // El nombre original se conserva solo como referencia, sin ruta.
    expect(historico?.nombre_archivo_original).toBe('passwd.csv');

    // El archivo quedo dentro del directorio de cargas configurado.
    const ruta = path.join(env.uploads.dir, historico!.nombre_archivo_seguro);
    expect(fs.existsSync(ruta)).toBe(true);
    expect(path.resolve(ruta).startsWith(path.resolve(env.uploads.dir))).toBe(true);
  });

  it('rechaza libros de calculo con macros', async () => {
    // Se simula un XLSX (ZIP) que declara un proyecto VBA.
    const contenido = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('xl/vbaProject.bin'),
      Buffer.alloc(64, 1),
    ]);

    const respuesta = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', contenido, 'con_macros.xlsx')
      .expect(422);

    expect(respuesta.body.error.mensaje).toContain('macros');
  });

  // -------------------------------------------------------------------------
  // Secretos y datos sensibles
  // -------------------------------------------------------------------------

  it('nunca devuelve hashes de contrasena en las respuestas del API', async () => {
    const lista = await comoUsuario(admin).get('/api/users').expect(200);
    expect(JSON.stringify(lista.body)).not.toContain('password_hash');
    expect(JSON.stringify(lista.body)).not.toContain('$2a$');
    expect(JSON.stringify(lista.body)).not.toContain('$2b$');

    const detalle = await comoUsuario(admin).get(`/api/users/${admin.usuario.id_usuario}`).expect(200);
    const cuerpo = JSON.stringify(detalle.body);
    expect(cuerpo).not.toContain('password_hash');
    expect(cuerpo).not.toMatch(/\$2[aby]\$/);
    // El unico campo con "password" en su nombre es la bandera de cambio obligatorio.
    expect(Object.keys(detalle.body.datos).filter((k) => k.includes('password'))).toEqual([
      'debe_cambiar_password',
    ]);
  });

  it('la auditoria redacta los campos sensibles', () => {
    const resultado = sanitizar({
      email: 'usuario@retse.com.gt',
      password: 'SuperSecreta.2026#',
      token: 'abc123',
      anidado: { systemCode: 'codigo-huawei', kwh: 100 },
    }) as Record<string, unknown>;

    expect(resultado.email).toBe('usuario@retse.com.gt');
    expect(resultado.password).toBe('[REDACTADO]');
    expect(resultado.token).toBe('[REDACTADO]');
    expect((resultado.anidado as Record<string, unknown>).systemCode).toBe('[REDACTADO]');
    expect((resultado.anidado as Record<string, unknown>).kwh).toBe(100);
  });

  it('el restablecimiento entrega una contrasena temporal fuerte y no revela la anterior', async () => {
    const idUsuario = operativo.usuario.id_usuario;
    const respuesta = await comoUsuario(admin)
      .post(`/api/users/${idUsuario}/reset-password`)
      .expect(200);

    const temporal = respuesta.body.datos.passwordTemporal as string;
    expect(temporal).toHaveLength(14);
    expect(temporal).toMatch(/[A-Z]/);
    expect(temporal).toMatch(/[a-z]/);
    expect(temporal).toMatch(/[0-9]/);
    expect(temporal).toMatch(/[^A-Za-z0-9]/);
    expect(JSON.stringify(respuesta.body)).not.toContain(PASSWORD_PRUEBAS);

    // La auditoria registra el hecho pero nunca la contrasena generada.
    const auditoria = await queryOne<{ contenido: string | null }>(
      `SELECT CONCAT(COALESCE(CAST(datos_despues AS CHAR), ''), COALESCE(motivo, '')) AS contenido
         FROM auditoria WHERE accion = 'PASSWORD_RESTABLECIDA' ORDER BY id_auditoria DESC LIMIT 1`,
    );
    expect(auditoria?.contenido ?? '').not.toContain(temporal);
  });

  it('al desactivar un usuario se revocan sus sesiones activas', async () => {
    await crearUsuario('seg.revocar@retse.com.gt', 'OPERATIVO');
    const sesion = await iniciarSesion('seg.revocar@retse.com.gt', PASSWORD_PRUEBAS);
    await comoUsuario(sesion).get('/api/auth/me').expect(200);

    await comoUsuario(admin)
      .put(`/api/users/${sesion.usuario.id_usuario}`)
      .send({ activo: false })
      .expect(200);

    // El token de acceso deja de ser valido de inmediato.
    await comoUsuario(sesion).get('/api/auth/me').expect(401);
    // Y la sesion tampoco puede renovarse.
    await request(obtenerApp())
      .post('/api/auth/refresh')
      .set('Cookie', sesion.cookies)
      .set('x-csrf-token', sesion.csrf)
      .expect(401);
  });

  // -------------------------------------------------------------------------
  // Cabeceras y contratos
  // -------------------------------------------------------------------------

  it('aplica las cabeceras de seguridad esperadas', async () => {
    const respuesta = await request(obtenerApp()).get('/health').expect(200);

    expect(respuesta.headers['content-security-policy']).toContain("default-src 'self'");
    expect(respuesta.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
    expect(respuesta.headers['x-frame-options']).toBeDefined();
    expect(respuesta.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(respuesta.headers['x-powered-by']).toBeUndefined();
  });

  it('no otorga cabeceras CORS a un origen no autorizado', async () => {
    const respuesta = await request(obtenerApp())
      .get('/health')
      .set('Origin', 'https://sitio-malicioso.example')
      .expect(200);

    expect(respuesta.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('permite el origen configurado del frontend', async () => {
    const respuesta = await request(obtenerApp())
      .get('/health')
      .set('Origin', env.corsOrigins[0])
      .expect(200);

    expect(respuesta.headers['access-control-allow-origin']).toBe(env.corsOrigins[0]);
    expect(respuesta.headers['access-control-allow-credentials']).toBe('true');
  });

  it('devuelve un identificador de correlacion en cada respuesta', async () => {
    const respuesta = await comoUsuario(admin).get('/api/clients').expect(200);
    expect(respuesta.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('responde 404 con contrato uniforme ante rutas inexistentes', async () => {
    const respuesta = await comoUsuario(admin).get('/api/ruta-que-no-existe').expect(404);
    expect(respuesta.body.ok).toBe(false);
    expect(respuesta.body.error.codigo).toBe('RUTA_NO_ENCONTRADA');
    expect(respuesta.body.error.mensaje).toContain('no existe');
  });

  it('valida y normaliza las entradas antes de procesarlas', async () => {
    const respuesta = await comoUsuario(admin)
      .post('/api/clients')
      .send({ nombre: 'A', nit: '' })
      .expect(422);

    expect(respuesta.body.error.codigo).toBe('VALIDACION');
    expect(Array.isArray(respuesta.body.error.detalles)).toBe(true);
    // Los mensajes de validacion estan en espanol.
    expect(JSON.stringify(respuesta.body.error.detalles)).toMatch(/caracteres|valido/);
  });

  it('protege la paginacion contra valores abusivos', async () => {
    await comoUsuario(admin).get('/api/clients').query({ porPagina: 100000 }).expect(422);
    await comoUsuario(admin).get('/api/clients').query({ pagina: -5 }).expect(422);
  });

  it('impide eliminar registros con relaciones y aplica desactivacion logica', async () => {
    const respuesta = await comoUsuario(admin).delete(`/api/clients/${datos.idCliente}`).expect(200);

    expect(respuesta.body.datos.eliminado).toBe(false);
    expect(respuesta.body.datos.mensaje).toContain('desactivado');

    const cliente = await queryOne<{ activo: number }>(
      'SELECT activo FROM clientes WHERE id_cliente = ?',
      [datos.idCliente],
    );
    expect(Number(cliente?.activo)).toBe(0);
  });
});
