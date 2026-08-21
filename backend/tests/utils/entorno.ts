import http from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import type { Express } from 'express';
import { crearApp } from '../../src/app';
import { closePool, execute, query, queryOne } from '../../src/db/pool';
import { createDatabase, dropDatabase, runMigrations } from '../../src/db/migrator';
import { bootstrapAdministrador } from '../../src/db/seed';
import { hashPassword } from '../../src/services/auth';

/**
 * Utilidades compartidas por las pruebas.
 *
 * Cada archivo de pruebas trabaja sobre la base `appsolar_test`, que se crea
 * desde cero con las migraciones reales: no se simula la base de datos.
 */

let app: Express | null = null;

export async function prepararBaseDeDatos(): Promise<void> {
  await dropDatabase();
  await createDatabase();
  await runMigrations();
  await bootstrapAdministrador();
}

export function obtenerApp(): Express {
  if (!app) app = crearApp();
  return app;
}

export async function cerrarTodo(): Promise<void> {
  await closePool();
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

export interface Sesion {
  cookies: string[];
  csrf: string;
  usuario: { id_usuario: number; rol: string; permisos: string[] };
}

function extraerCsrf(cookies: string[]): string {
  const cookie = cookies.find((c) => c.startsWith('as_csrf='));
  return cookie ? decodeURIComponent(cookie.split(';')[0].split('=')[1]) : '';
}

export async function iniciarSesion(email: string, password: string): Promise<Sesion> {
  const respuesta = await request(obtenerApp())
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);

  const cookies = (respuesta.headers['set-cookie'] as unknown as string[]) ?? [];
  return {
    cookies,
    csrf: extraerCsrf(cookies),
    usuario: respuesta.body.datos.usuario,
  };
}

/** Peticion autenticada con cookies y token CSRF ya aplicados. */
export function comoUsuario(sesion: Sesion) {
  const agente = request(obtenerApp());
  const conCabeceras = (peticion: request.Test) =>
    peticion.set('Cookie', sesion.cookies).set('x-csrf-token', sesion.csrf);

  return {
    get: (ruta: string) => conCabeceras(agente.get(ruta)),
    post: (ruta: string) => conCabeceras(agente.post(ruta)),
    put: (ruta: string) => conCabeceras(agente.put(ruta)),
    delete: (ruta: string) => conCabeceras(agente.delete(ruta)),
  };
}

// ---------------------------------------------------------------------------
// Usuarios de prueba
// ---------------------------------------------------------------------------

export const PASSWORD_PRUEBAS = 'Pruebas.2026#Clave';

export async function crearUsuario(
  email: string,
  rol: 'ADMINISTRATIVO' | 'OPERATIVO' | 'GERENCIAL',
  permisosExtra: string[] = [],
): Promise<number> {
  const filaRol = await queryOne<{ id_rol: number }>('SELECT id_rol FROM roles WHERE codigo = ?', [rol]);
  const resultado = await execute(
    `INSERT INTO usuarios (nombre, email, password_hash, id_rol, activo, debe_cambiar_password)
     VALUES (?, ?, ?, ?, 1, 0)`,
    [`Usuario ${rol}`, email, await hashPassword(PASSWORD_PRUEBAS), filaRol!.id_rol],
  );

  for (const codigo of permisosExtra) {
    const permiso = await queryOne<{ id_permiso: number }>(
      'SELECT id_permiso FROM permisos WHERE codigo = ?',
      [codigo],
    );
    if (permiso) {
      await execute(
        'INSERT INTO usuario_permisos (id_usuario, id_permiso, otorgado) VALUES (?, ?, 1)',
        [resultado.insertId, permiso.id_permiso],
      );
    }
  }

  return resultado.insertId;
}

// ---------------------------------------------------------------------------
// Datos base
// ---------------------------------------------------------------------------

export interface DatosBase {
  idCliente: number;
  idProyecto: number;
  idInversor: number;
  idInversorHuawei: number;
  idApi: number;
}

export async function crearDatosBase(sufijo = ''): Promise<DatosBase> {
  const cliente = await execute(
    'INSERT INTO clientes (nombre, nit, ubicacion, activo) VALUES (?, ?, ?, 1)',
    [`Cliente Pruebas${sufijo}`, `9999999${sufijo || '0'}-1`, 'Guatemala'],
  );

  const proyecto = await execute(
    `INSERT INTO proyectos (id_cliente, nombre, ubicacion, tipo_proyecto, capacidad_kwp, activo)
     VALUES (?, ?, ?, 'PPA', 500, 1)`,
    [cliente.insertId, `Planta Pruebas${sufijo}`, 'Escuintla'],
  );

  const api = await execute(
    `INSERT INTO apis_fabricante (marca, nombre, endpoint, modo, estado, timeout_s, max_reintentos)
     VALUES ('HUAWEI', ?, 'http://127.0.0.1:9/thirdData', 'MOCK', 'ACTIVA', 10, 1)`,
    [`Huawei Pruebas${sufijo}`],
  );

  const inversor = await execute(
    `INSERT INTO inversores (id_proyecto, marca, modelo, tipo_conexion, serial_externo, capacidad_kwp, estado, activo)
     VALUES (?, 'Fronius', 'Symo 24', 'MANUAL', ?, 250, 'ACTIVO', 1)`,
    [proyecto.insertId, `SN-MAN${sufijo || '0'}`],
  );

  const inversorHuawei = await execute(
    `INSERT INTO inversores (id_proyecto, marca, modelo, tipo_conexion, serial_externo, estacion_externa, capacidad_kwp, estado, id_api, activo)
     VALUES (?, 'Huawei', 'SUN2000', 'HUAWEI_API', ?, 'NE=PRUEBA', 250, 'ACTIVO', ?, 1)`,
    [proyecto.insertId, `SN-HW${sufijo || '0'}`, api.insertId],
  );

  return {
    idCliente: cliente.insertId,
    idProyecto: proyecto.insertId,
    idInversor: inversor.insertId,
    idInversorHuawei: inversorHuawei.insertId,
    idApi: api.insertId,
  };
}

export async function crearTarifaAprobada(
  idProyecto: number,
  anio: number,
  mes: number,
  costo: number,
): Promise<number> {
  const resultado = await execute(
    `INSERT INTO tarifas_kwh (id_proyecto, anio, mes, costo_kwh, moneda, estado, fecha_aprobacion)
     VALUES (?, ?, ?, ?, 'GTQ', 'APROBADA', NOW())`,
    [idProyecto, anio, mes, costo],
  );
  return resultado.insertId;
}

export async function limpiarDatos(): Promise<void> {
  // El orden respeta las claves foraneas.
  for (const tabla of [
    'produccion_ajustes',
    'produccion',
    'historico_errores',
    'historicos',
    'sincronizaciones',
    'reportes',
    'tarifas_kwh',
    'proyecciones_kwh',
    'cierres_mensuales',
    'inversores',
    'proyectos',
    'clientes',
    'apis_fabricante',
    'bloqueos',
    'auditoria',
  ]) {
    await execute(`DELETE FROM ${tabla}`);
  }
}

export async function contarAuditoria(accion: string): Promise<number> {
  const fila = await queryOne<{ total: number }>(
    'SELECT COUNT(*) AS total FROM auditoria WHERE accion = ?',
    [accion],
  );
  return Number(fila?.total ?? 0);
}

export async function filasProduccion(idProyecto: number) {
  return query<{
    id_produccion: number;
    kwh: number;
    valor_q: number | null;
    costo_kwh_aplicado: number | null;
    estado_valorizacion: string;
    nivel_detalle: string;
    granularidad: string;
    secuencia: number;
    anio: number;
    mes: number;
  }>(
    `SELECT id_produccion, kwh, valor_q, costo_kwh_aplicado, estado_valorizacion,
            nivel_detalle, granularidad, secuencia, anio, mes
       FROM produccion WHERE id_proyecto = ? AND activo = 1 ORDER BY fecha, secuencia`,
    [idProyecto],
  );
}

// ---------------------------------------------------------------------------
// Servicio Python simulado (para las pruebas de integracion Huawei)
// ---------------------------------------------------------------------------

export type ComportamientoPython =
  | { tipo: 'EXITO'; registros: Array<{ serial: string; fecha: string; kwh: number }> }
  | { tipo: 'ERROR'; codigo: string; estado: number; mensaje: string }
  | { tipo: 'TIMEOUT' };

/**
 * Levanta un doble del servicio Python que respeta su mismo contrato HTTP.
 * Permite probar exito, credenciales invalidas, IP no autorizada y timeout sin
 * depender de la disponibilidad del servicio real ni del fabricante.
 */
export async function levantarPythonSimulado(
  obtenerComportamiento: () => ComportamientoPython,
): Promise<{ url: string; cerrar: () => Promise<void> }> {
  const servidor = http.createServer((req, res) => {
    const comportamiento = obtenerComportamiento();

    if (comportamiento.tipo === 'TIMEOUT') {
      // No se responde: el cliente debe abortar por su propio tiempo de espera.
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: 'prueba', modo: 'MOCK' }));
      return;
    }

    if (comportamiento.tipo === 'ERROR') {
      res.writeHead(comportamiento.estado, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: false, codigo: comportamiento.codigo, mensaje: comportamiento.mensaje }),
      );
      return;
    }

    let cuerpo = '';
    req.on('data', (parte) => {
      cuerpo += parte;
    });
    req.on('end', () => {
      const peticion = cuerpo ? JSON.parse(cuerpo) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          modo: 'MOCK',
          registros: comportamiento.registros.map((r) => ({ ...r, granularidad: 'DIARIA' })),
          advertencias: ['DATOS SIMULADOS: generados por el doble de pruebas.'],
          duracion_ms: 5,
          rango: { desde: peticion.desde ?? null, hasta: peticion.hasta ?? null },
        }),
      );
    });
  });

  await new Promise<void>((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const puerto = (servidor.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${puerto}`,
    cerrar: () =>
      new Promise<void>((resolver) => {
        servidor.closeAllConnections?.();
        servidor.close(() => resolver());
      }),
  };
}
