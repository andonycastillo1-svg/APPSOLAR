import pino from 'pino';
import { env } from './env';

/**
 * Logger estructurado con redaccion obligatoria de secretos.
 * Nunca deben aparecer contrasenas, tokens ni cookies en los registros.
 */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.passwordActual',
  'req.body.passwordNueva',
  'req.body.contrasena',
  'password',
  'passwordActual',
  'passwordNueva',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'systemCode',
  'secreto',
  '*.password',
  '*.token',
];

export const logger = pino({
  level: env.logLevel,
  redact: { paths: REDACT, censor: '[REDACTADO]' },
  base: { servicio: 'appsolar-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    !env.isProduction && !env.isTest
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});

export type Logger = typeof logger;
