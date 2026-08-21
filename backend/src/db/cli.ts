import { env } from '../config/env';
import { logger } from '../config/logger';
import { closePool } from './pool';
import { createDatabase, dropDatabase, runMigrations } from './migrator';
import { bootstrapAdministrador, sembrarDemostracion } from './seed';

/**
 * CLI de base de datos.
 *   npm run db:create     Crea el esquema si no existe
 *   npm run db:migrate    Aplica las migraciones pendientes
 *   npm run db:bootstrap  Crea el administrador inicial (desde variables de entorno)
 *   npm run db:seed       Crea admin + datos de demostracion
 *   npm run db:reset      Borra, recrea, migra y siembra (NUNCA en produccion)
 */
async function principal(): Promise<void> {
  const comando = process.argv[2];

  switch (comando) {
    case 'create':
      await createDatabase();
      break;

    case 'migrate': {
      await createDatabase();
      const resultado = await runMigrations();
      logger.info(
        `Migraciones: ${resultado.aplicadas.length} aplicada(s), ${resultado.omitidas.length} ya estaban al dia.`,
      );
      break;
    }

    case 'bootstrap':
      await bootstrapAdministrador();
      break;

    case 'seed':
      await bootstrapAdministrador();
      if (env.bootstrap.seedDemo) {
        await sembrarDemostracion();
      } else {
        logger.warn('SEED_DEMO_DATA esta deshabilitado: no se crearon datos de demostracion.');
      }
      break;

    case 'reset': {
      if (env.isProduction) {
        throw new Error('El comando "reset" esta bloqueado en produccion.');
      }
      await dropDatabase();
      await createDatabase();
      const resultado = await runMigrations();
      logger.info(`Migraciones aplicadas: ${resultado.aplicadas.join(', ')}`);
      await bootstrapAdministrador();
      if (env.bootstrap.seedDemo) await sembrarDemostracion();
      break;
    }

    default:
      logger.error(
        'Comando no reconocido. Use: create | migrate | bootstrap | seed | reset',
      );
      process.exitCode = 1;
  }

  await closePool();
}

principal().catch(async (error) => {
  logger.error({ err: error }, error instanceof Error ? error.message : 'Error en el CLI');
  await closePool().catch(() => undefined);
  process.exit(1);
});
