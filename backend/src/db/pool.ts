import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../config/logger';

let pool: Pool | null = null;

/**
 * Pool de conexiones MySQL.
 *
 * Decisiones deliberadas:
 *  - `dateStrings: true`  -> las columnas DATE/DATETIME viajan como texto y se
 *    evita el desplazamiento de zona horaria entre Node y MySQL.
 *  - `decimalNumbers: true` -> los DECIMAL llegan como number. Los rangos de
 *    kWh y quetzales manejados por el sistema estan muy por debajo del limite
 *    seguro de JavaScript, y el redondeo se controla en `utils/decimal.ts`.
 *  - `multipleStatements: false` -> defensa adicional contra inyeccion SQL.
 *    El ejecutor de migraciones abre su propia conexion con la bandera activa.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      waitForConnections: true,
      connectionLimit: env.db.connectionLimit,
      queueLimit: 0,
      charset: 'utf8mb4_unicode_ci',
      dateStrings: true,
      decimalNumbers: true,
      multipleStatements: false,
      timezone: 'Z',
      supportBigNumbers: true,
      namedPlaceholders: false,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type Executor = Pool | PoolConnection;

export async function query<T = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  executor: Executor = getPool(),
): Promise<T[]> {
  const [rows] = await executor.query(sql, params);
  return rows as T[];
}

export async function queryOne<T = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  executor: Executor = getPool(),
): Promise<T | null> {
  const rows = await query<T>(sql, params, executor);
  return rows.length > 0 ? rows[0] : null;
}

export async function execute(
  sql: string,
  params: unknown[] = [],
  executor: Executor = getPool(),
): Promise<ResultSetHeader> {
  const [result] = await executor.query(sql, params);
  return result as ResultSetHeader;
}

/**
 * Ejecuta un bloque dentro de una transaccion. Toda importacion, correccion de
 * tarifas o sincronizacion debe usarla para no dejar lotes inconsistentes.
 */
export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'Fallo al revertir la transaccion');
    }
    throw error;
  } finally {
    conn.release();
  }
}

/** Conexion administrativa (sin base seleccionada) para crear/borrar esquemas. */
export async function adminConnection() {
  return mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: process.env.DB_ROOT_USER || env.db.user,
    password: process.env.DB_ROOT_PASSWORD || env.db.password,
    multipleStatements: true,
  });
}

export async function ping(): Promise<boolean> {
  try {
    await query('SELECT 1 AS ok');
    return true;
  } catch {
    return false;
  }
}
