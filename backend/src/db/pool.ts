import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../config/logger';

let pool: Pool | null = null;

/** Columnas definidas como JSON en las migraciones. */
const COLUMNAS_JSON = new Set([
  'datos_antes',
  'datos_despues',
  'decisiones',
  'resumen',
  'detalle',
  'parametros',
]);

/**
 * En MySQL el driver entrega las columnas JSON ya convertidas en objetos; en
 * MariaDB el tipo JSON es un alias de texto y llegan como cadena. Se unifica el
 * comportamiento para que la API responda lo mismo con cualquiera de los dos.
 */
export function convertirTipo(
  field: { name: string; type: string; string: () => string | null },
  siguiente: () => unknown,
): unknown {
  if (COLUMNAS_JSON.has(field.name) && field.type !== 'JSON') {
    const texto = field.string();
    if (texto && /^\s*[\[{]/.test(texto)) {
      try {
        return JSON.parse(texto);
      } catch {
        return texto;
      }
    }
    return texto;
  }
  return siguiente();
}

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
      timezone: env.db.timezone,
      supportBigNumbers: true,
      namedPlaceholders: false,
      typeCast: convertirTipo as never,
      // Los hostings compartidos cierran las conexiones inactivas (en Hostinger,
      // wait_timeout = 20 s). El pool las descarta ANTES de que el servidor las corte,
      // para que ninguna consulta caiga sobre una conexion ya muerta.
      connectTimeout: 10_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 5_000,
      maxIdle: Math.min(3, env.db.connectionLimit),
      idleTimeout: env.db.idleTimeoutMs,
    });
    // Toda conexion nueva trabaja en la zona horaria de Guatemala: la auditoria y los demas sellos de
    // tiempo (NOW()) quedan en la misma hora que ve el usuario, tambien al consultar la base directamente.
    pool.on('connection', (conexion) => {
      conexion.query(`SET time_zone = '${env.db.timezone}'`);
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

const ERRORES_CONEXION_PERDIDA = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ER_SERVER_SHUTDOWN',
]);

export async function query<T = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  executor: Executor = getPool(),
): Promise<T[]> {
  try {
    const [rows] = await executor.query(sql, params);
    return rows as T[];
  } catch (error) {
    // Una lectura que cae sobre una conexion que el servidor ya cerro se repite una vez
    // con una conexion nueva. Las escrituras no se repiten: podrian duplicarse.
    const codigo = (error as { code?: string }).code ?? '';
    const esLectura = /^\s*(SELECT|SHOW)/i.test(sql);
    if (esLectura && ERRORES_CONEXION_PERDIDA.has(codigo) && executor === pool) {
      logger.warn({ codigo }, 'Conexion a la base perdida; se repite la lectura una vez.');
      const [rows] = await executor.query(sql, params);
      return rows as T[];
    }
    throw error;
  }
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
