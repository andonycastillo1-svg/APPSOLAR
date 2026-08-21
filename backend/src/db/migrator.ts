import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../config/logger';

const CONTROL_TABLE = `
CREATE TABLE IF NOT EXISTS _migraciones (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  archivo     VARCHAR(160) NOT NULL,
  hash_sha256 CHAR(64) NOT NULL,
  ejecutada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duracion_ms INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_migraciones_archivo (archivo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

export interface MigrationResult {
  aplicadas: string[];
  omitidas: string[];
}

function migrationFiles(): string[] {
  if (!fs.existsSync(env.paths.migrations)) return [];
  return fs
    .readdirSync(env.paths.migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Crea la base de datos si no existe (usa credenciales administrativas). */
export async function createDatabase(): Promise<void> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: process.env.DB_ROOT_USER || env.db.user,
    password: process.env.DB_ROOT_PASSWORD || env.db.password,
    multipleStatements: true,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    );
    logger.info(`Base de datos "${env.db.database}" disponible.`);
  } finally {
    await conn.end();
  }
}

export async function dropDatabase(): Promise<void> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: process.env.DB_ROOT_USER || env.db.user,
    password: process.env.DB_ROOT_PASSWORD || env.db.password,
    multipleStatements: true,
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${env.db.database}\`;`);
    logger.warn(`Base de datos "${env.db.database}" eliminada.`);
  } finally {
    await conn.end();
  }
}

/**
 * Aplica las migraciones pendientes en orden alfabetico. Cada archivo se
 * registra con su hash para detectar modificaciones posteriores.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
  });

  const aplicadas: string[] = [];
  const omitidas: string[] = [];

  try {
    await conn.query(CONTROL_TABLE);
    const [rows] = await conn.query('SELECT archivo, hash_sha256 FROM _migraciones');
    const previas = new Map(
      (rows as Array<{ archivo: string; hash_sha256: string }>).map((r) => [
        r.archivo,
        r.hash_sha256,
      ]),
    );

    for (const archivo of migrationFiles()) {
      const contenido = fs.readFileSync(path.join(env.paths.migrations, archivo), 'utf8');
      const hash = crypto.createHash('sha256').update(contenido).digest('hex');

      if (previas.has(archivo)) {
        if (previas.get(archivo) !== hash) {
          logger.warn(
            `La migracion ${archivo} cambio despues de aplicarse. ` +
              'Cree una nueva migracion en lugar de editar una existente.',
          );
        }
        omitidas.push(archivo);
        continue;
      }

      const inicio = Date.now();
      try {
        await conn.query(contenido);
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        throw new Error(`Error al aplicar la migracion ${archivo}: ${detalle}`);
      }
      const duracion = Date.now() - inicio;
      await conn.query(
        'INSERT INTO _migraciones (archivo, hash_sha256, duracion_ms) VALUES (?, ?, ?)',
        [archivo, hash, duracion],
      );
      aplicadas.push(archivo);
      logger.info(`Migracion aplicada: ${archivo} (${duracion} ms)`);
    }
  } finally {
    await conn.end();
  }

  return { aplicadas, omitidas };
}
