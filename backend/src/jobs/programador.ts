import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { execute, query } from '../db/pool';
import { ejecutarSincronizacion } from '../services/sincronizacion';
import { obtenerBooleano, obtenerNumero } from '../services/configuracion';
import { hoyISO, ZONA_HORARIA } from '../utils/fechas';

let tareaSincronizacion: ScheduledTask | null = null;
let tareaMantenimiento: ScheduledTask | null = null;

/** Sincronizacion programada de todas las integraciones activas. */
async function ejecutarSincronizacionProgramada(): Promise<void> {
  const habilitada = await obtenerBooleano('sync.programada', env.sync.cronEnabled);
  if (!habilitada) return;

  const diasAtras = await obtenerNumero('sync.dias_atras', 7);
  const hasta = hoyISO();
  const desde = new Date(`${hasta}T00:00:00Z`);
  desde.setUTCDate(desde.getUTCDate() - diasAtras);

  const apis = await query<{ id_api: number; marca: string }>(
    "SELECT id_api, marca FROM apis_fabricante WHERE estado = 'ACTIVA' AND sync_programada = 1",
  );

  for (const api of apis) {
    try {
      const resultado = await ejecutarSincronizacion({
        idApi: api.id_api,
        desde: desde.toISOString().slice(0, 10),
        hasta,
        granularidad: 'DIARIA',
        tipo: 'PROGRAMADA',
        idUsuario: null,
        emailUsuario: 'tarea-programada@sistema',
      });
      logger.info(
        { idSync: resultado.id_sync, marca: api.marca },
        `Sincronizacion programada finalizada: ${resultado.mensaje}`,
      );
    } catch (error) {
      logger.error({ err: error, marca: api.marca }, 'Fallo la sincronizacion programada');
    }
  }
}

/** Limpieza periodica de tokens vencidos, bloqueos y lotes abandonados. */
async function mantenimiento(): Promise<void> {
  try {
    const tokens = await execute(
      'DELETE FROM refresh_tokens WHERE expira_en < DATE_SUB(NOW(), INTERVAL 30 DAY)',
    );
    const bloqueos = await execute('DELETE FROM bloqueos WHERE expira_en <= NOW()');
    const lotes = await execute(
      `UPDATE historicos SET estado = 'EXPIRADO'
        WHERE estado = 'VALIDADO' AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );
    logger.info(
      { tokens: tokens.affectedRows, bloqueos: bloqueos.affectedRows, lotes: lotes.affectedRows },
      'Mantenimiento periodico ejecutado',
    );
  } catch (error) {
    logger.error({ err: error }, 'Fallo el mantenimiento periodico');
  }
}

export function iniciarTareasProgramadas(): void {
  if (env.isTest) return;

  const expresion = `${env.sync.minute} ${env.sync.hour} * * *`;
  if (cron.validate(expresion)) {
    tareaSincronizacion = cron.schedule(
      expresion,
      () => void ejecutarSincronizacionProgramada(),
      { timezone: ZONA_HORARIA },
    );
    logger.info(
      `Sincronizacion programada registrada para las ${String(env.sync.hour).padStart(2, '0')}:${String(env.sync.minute).padStart(2, '0')} (${ZONA_HORARIA}). ` +
        `Habilitada: ${env.sync.cronEnabled}.`,
    );
  }

  tareaMantenimiento = cron.schedule('15 3 * * *', () => void mantenimiento(), {
    timezone: ZONA_HORARIA,
  });
}

export function detenerTareasProgramadas(): void {
  tareaSincronizacion?.stop();
  tareaMantenimiento?.stop();
  tareaSincronizacion = null;
  tareaMantenimiento = null;
}
