import { env } from './config/env';
import { logger } from './config/logger';
import { crearApp } from './app';
import { closePool, ping } from './db/pool';
import { runMigrations } from './db/migrator';
import { asegurarIntegracionHuawei, bootstrapAdministrador } from './db/seed';
import { iniciarTareasProgramadas, detenerTareasProgramadas } from './jobs/programador';

process.env.TZ = env.timezone;

async function iniciar(): Promise<void> {
  if (env.autoMigrate) {
    try {
      const resultado = await runMigrations();
      logger.info(
        `Migraciones automaticas: ${resultado.aplicadas.length} aplicada(s), ${resultado.omitidas.length} al dia.`,
      );
      await bootstrapAdministrador();
      await asegurarIntegracionHuawei();
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error },
        `Fallo la preparacion automatica de la base de datos (${env.db.user}@${env.db.host}/${env.db.database}): ${motivo}`,
      );
      process.exit(1);
    }
  }

  const disponible = await ping();
  if (!disponible) {
    logger.error(
      `No fue posible conectar con MySQL (${env.db.host}:${env.db.port}/${env.db.database}). ` +
        'Verifique las variables de entorno y que las migraciones se hayan ejecutado.',
    );
    process.exit(1);
  }

  const app = crearApp();
  const servidor = app.listen(env.port, env.host, () => {
    logger.info(
      `API disponible en http://localhost:${env.port}${env.apiPrefix} (escuchando en ${env.host}) ` +
        `[entorno: ${env.nodeEnv}, zona horaria: ${env.timezone}, Huawei: ${env.huawei.mode}]`,
    );
  });

  iniciarTareasProgramadas();

  const apagar = async (senal: string) => {
    logger.info(`Señal ${senal} recibida: cerrando el servicio de forma ordenada.`);
    detenerTareasProgramadas();
    servidor.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Cierre forzado si alguna conexion queda colgada.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
  process.on('unhandledRejection', (razon) => {
    logger.error({ err: razon }, 'Promesa rechazada sin manejar');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Excepcion no capturada');
    process.exit(1);
  });
}

void iniciar();
