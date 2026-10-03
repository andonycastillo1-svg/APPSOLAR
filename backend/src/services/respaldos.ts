import fs from 'node:fs';
import path from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { getPool, query } from '../db/pool';
import { errores } from '../utils/errors';

/**
 * Respaldo y restauracion de los datos desde la propia aplicacion.
 *
 * Formato: un archivo JSON propio (no SQL). Al restaurar NO se ejecuta ninguna
 * sentencia contenida en el archivo: cada nombre de tabla y de columna se valida
 * contra el esquema real y los valores viajan como parametros, de modo que un
 * archivo manipulado no puede ejecutar SQL arbitrario.
 *
 * Alcance: todas las tablas de negocio, usuarios y permisos incluidos. Se excluyen
 * las sesiones activas, los bloqueos temporales y el control de migraciones.
 */

export const FORMATO_RESPALDO = 'appsolar-respaldo';
export const VERSION_RESPALDO = 1;

const EXCLUIDAS = new Set(['refresh_tokens', 'bloqueos', '_migraciones']);
const LOTE_INSERCION = 500;
const COPIAS_PREVIAS_A_CONSERVAR = 5;

export interface TablaRespaldo {
  columnas: string[];
  filas: unknown[][];
}

export interface Respaldo {
  formato: string;
  version: number;
  generado_en: string;
  base: string;
  migraciones: string[];
  tablas: Record<string, TablaRespaldo>;
}

type Ejecutor = PoolConnection | undefined;

async function tablasDelEsquema(ejecutor?: Ejecutor): Promise<string[]> {
  const filas = await query<{ n: string }>(
    `SELECT table_name AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [],
    ejecutor,
  );
  return filas.map((f) => f.n).filter((n) => !EXCLUIDAS.has(n));
}

/** Columnas que se pueden escribir (se omiten las generadas). */
async function columnasEscribibles(tabla: string, ejecutor?: Ejecutor): Promise<string[]> {
  const filas = await query<{ c: string; e: string }>(
    `SELECT column_name AS c, extra AS e FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY ordinal_position`,
    [tabla],
    ejecutor,
  );
  return filas.filter((f) => !/GENERATED|VIRTUAL|STORED/i.test(f.e ?? '')).map((f) => f.c);
}

async function migracionesAplicadas(ejecutor?: Ejecutor): Promise<string[]> {
  const filas = await query<{ archivo: string }>(
    'SELECT archivo FROM _migraciones ORDER BY archivo',
    [],
    ejecutor,
  );
  return filas.map((f) => f.archivo);
}

const idCitado = (nombre: string) => `\`${nombre.replace(/`/g, '')}\``;

export async function generarRespaldo(): Promise<Respaldo> {
  const conn = await getPool().getConnection();
  try {
    // Una sola vista consistente de todas las tablas.
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');

    const tablas: Record<string, TablaRespaldo> = {};
    for (const tabla of await tablasDelEsquema(conn)) {
      const columnas = await columnasEscribibles(tabla, conn);
      const filas = await query<Record<string, unknown>>(
        `SELECT ${columnas.map(idCitado).join(', ')} FROM ${idCitado(tabla)}`,
        [],
        conn,
      );
      tablas[tabla] = { columnas, filas: filas.map((f) => columnas.map((c) => f[c])) };
    }

    const respaldo: Respaldo = {
      formato: FORMATO_RESPALDO,
      version: VERSION_RESPALDO,
      generado_en: new Date().toISOString(),
      base: env.db.database,
      migraciones: await migracionesAplicadas(conn),
      tablas,
    };
    await conn.query('ROLLBACK');
    return respaldo;
  } finally {
    conn.release();
  }
}

/** Valida el archivo contra el esquema vigente. Devuelve el orden de tablas a restaurar. */
async function validarRespaldo(datos: unknown): Promise<string[]> {
  const invalido = (mensaje: string) => errores.validacion(mensaje);

  if (!datos || typeof datos !== 'object') throw invalido('El archivo no es un respaldo valido.');
  const r = datos as Partial<Respaldo>;

  if (r.formato !== FORMATO_RESPALDO) {
    throw invalido('El archivo no es un respaldo generado por este sistema.');
  }
  if (r.version !== VERSION_RESPALDO) {
    throw invalido(`La version del respaldo (${String(r.version)}) no es compatible con este sistema.`);
  }
  if (!Array.isArray(r.migraciones) || !r.tablas || typeof r.tablas !== 'object') {
    throw invalido('El respaldo esta incompleto o dañado.');
  }

  const actuales = await migracionesAplicadas();
  const igual =
    actuales.length === r.migraciones.length && actuales.every((m, i) => m === r.migraciones![i]);
  if (!igual) {
    throw invalido(
      'El respaldo corresponde a otra version de la estructura de datos. ' +
        'Restaurelo en un sistema con la misma version con que se genero.',
    );
  }

  const tablasEsquema = await tablasDelEsquema();
  const enRespaldo = Object.keys(r.tablas);

  const sobrantes = enRespaldo.filter((t) => !tablasEsquema.includes(t));
  if (sobrantes.length > 0) {
    throw invalido(`El respaldo contiene tablas desconocidas: ${sobrantes.join(', ')}.`);
  }
  const faltantes = tablasEsquema.filter((t) => !enRespaldo.includes(t));
  if (faltantes.length > 0) {
    throw invalido(`Al respaldo le faltan tablas: ${faltantes.join(', ')}.`);
  }

  for (const tabla of tablasEsquema) {
    const contenido = r.tablas[tabla];
    const permitidas = await columnasEscribibles(tabla);
    if (!contenido || !Array.isArray(contenido.columnas) || !Array.isArray(contenido.filas)) {
      throw invalido(`La tabla ${tabla} del respaldo esta dañada.`);
    }
    const ajenas = contenido.columnas.filter((c) => typeof c !== 'string' || !permitidas.includes(c));
    if (ajenas.length > 0) {
      throw invalido(`La tabla ${tabla} contiene columnas desconocidas: ${ajenas.join(', ')}.`);
    }
    const ancho = contenido.columnas.length;
    for (const fila of contenido.filas) {
      if (!Array.isArray(fila) || fila.length !== ancho) {
        throw invalido(`La tabla ${tabla} del respaldo tiene filas con formato invalido.`);
      }
    }
  }
  return tablasEsquema;
}

function aValor(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function directorioCopias(): string {
  const dir = path.join(env.uploads.dir, 'respaldos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Guarda en el servidor una copia del estado actual antes de reemplazarlo. */
async function guardarCopiaPrevia(): Promise<string> {
  const dir = directorioCopias();
  const marca = new Date().toISOString().replace(/[:.]/g, '-');
  const nombre = `previo_${marca}.json`;
  fs.writeFileSync(path.join(dir, nombre), JSON.stringify(await generarRespaldo()), { mode: 0o600 });

  const previas = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('previo_') && f.endsWith('.json'))
    .sort();
  for (const vieja of previas.slice(0, Math.max(0, previas.length - COPIAS_PREVIAS_A_CONSERVAR))) {
    fs.unlinkSync(path.join(dir, vieja));
  }
  return nombre;
}

export interface ResultadoRestauracion {
  tablas: number;
  filas: number;
  copia_previa: string;
}

export async function restaurarRespaldo(datos: unknown): Promise<ResultadoRestauracion> {
  const orden = await validarRespaldo(datos);
  const respaldo = datos as Respaldo;

  const copiaPrevia = await guardarCopiaPrevia();

  const conn = await getPool().getConnection();
  let filasTotales = 0;
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.beginTransaction();

    for (const tabla of orden) {
      await conn.query(`DELETE FROM ${idCitado(tabla)}`);
    }

    for (const tabla of orden) {
      const { columnas, filas } = respaldo.tablas[tabla];
      if (filas.length === 0 || columnas.length === 0) continue;
      const sql = `INSERT INTO ${idCitado(tabla)} (${columnas.map(idCitado).join(', ')}) VALUES ?`;
      for (let i = 0; i < filas.length; i += LOTE_INSERCION) {
        const lote = filas.slice(i, i + LOTE_INSERCION).map((f) => f.map(aValor));
        await conn.query(sql, [lote]);
      }
      filasTotales += filas.length;
    }

    await conn.commit();
  } catch (error) {
    try {
      await conn.rollback();
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'Fallo al revertir la restauracion');
    }
    throw error;
  } finally {
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } catch {
      /* la conexion se descarta igualmente */
    }
    conn.release();
  }

  return { tablas: orden.length, filas: filasTotales, copia_previa: copiaPrevia };
}
