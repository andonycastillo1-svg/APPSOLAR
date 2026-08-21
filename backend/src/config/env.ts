import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

/**
 * Carga de variables de entorno.
 * Se busca primero un `.env` en la raiz del monorepo y luego uno propio del
 * backend, de modo que un despliegue pueda separar la configuracion por
 * servicio sin duplicar valores comunes.
 */
const rootDir = path.resolve(__dirname, '..', '..', '..');
for (const candidate of [
  path.join(rootDir, '.env'),
  path.join(rootDir, 'backend', '.env'),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate, override: false });
}

function str(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Falta la variable de entorno obligatoria: ${key}`);
  }
  return value;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`La variable ${key} debe ser numerica`);
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'si', 'yes'].includes(raw.toLowerCase());
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

/** Secretos: en produccion se exige un valor explicito y suficientemente largo. */
function secret(key: string, devFallback: string): string {
  const value = process.env[key];
  if (!value || value.startsWith('CAMBIE_ESTE_VALOR')) {
    if (isProduction) {
      throw new Error(
        `La variable ${key} debe definirse con un valor real en produccion.`,
      );
    }
    return devFallback;
  }
  if (isProduction && value.length < 32) {
    throw new Error(`La variable ${key} debe tener al menos 32 caracteres.`);
  }
  return value;
}

export const env = {
  nodeEnv,
  isProduction,
  isTest,
  timezone: str('TZ', 'America/Guatemala'),
  appName: str('APP_NAME', 'Monitoreo Energetico Retse'),
  publicUrl: str('APP_PUBLIC_URL', 'http://localhost:5173'),
  port: num('PORT', 4000),
  // Interfaz de escucha. 0.0.0.0 garantiza IPv4 + IPv6 en Windows, Linux y Docker.
  host: str('HOST', '0.0.0.0'),
  apiPrefix: str('API_PREFIX', '/api'),
  trustProxy: num('TRUST_PROXY', 0),
  logLevel: str('LOG_LEVEL', isTest ? 'silent' : 'info'),
  corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: num('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: isTest
      ? str('DB_NAME_TEST', `${str('DB_NAME', 'appsolar')}_test`)
      : str('DB_NAME', 'appsolar'),
    connectionLimit: num('DB_CONNECTION_LIMIT', 10),
  },

  auth: {
    accessSecret: secret('JWT_ACCESS_SECRET', 'desarrollo-access-secret-no-usar-en-produccion'),
    refreshSecret: secret('JWT_REFRESH_SECRET', 'desarrollo-refresh-secret-no-usar-en-produccion'),
    accessTtlMin: num('ACCESS_TOKEN_TTL_MIN', 15),
    refreshTtlDays: num('REFRESH_TOKEN_TTL_DAYS', 7),
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
    cookieSecure: bool('COOKIE_SECURE', isProduction),
    cookieSameSite: (str('COOKIE_SAMESITE', 'lax') as 'lax' | 'strict' | 'none'),
    bcryptRounds: num('BCRYPT_ROUNDS', isTest ? 6 : 12),
    loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
    loginLockMinutes: num('LOGIN_LOCK_MINUTES', 15),
    rateLimitWindowMin: num('RATE_LIMIT_WINDOW_MIN', 15),
    rateLimitMax: num('RATE_LIMIT_MAX', 300),
  },

  uploads: {
    dir: path.resolve(rootDir, str('UPLOAD_DIR', './storage/uploads')),
    maxMb: num('MAX_UPLOAD_MB', 10),
    allowedExt: str('ALLOWED_UPLOAD_EXT', '.csv,.xlsx')
      .split(',')
      .map((e) => e.trim().toLowerCase()),
  },

  python: {
    url: str('PYTHON_SERVICE_URL', 'http://127.0.0.1:8000'),
    token: secret('PYTHON_SERVICE_TOKEN', 'token-interno-desarrollo'),
    timeoutMs: num('PYTHON_SERVICE_TIMEOUT_MS', 45000),
  },

  huawei: {
    mode: (str('HUAWEI_MODE', 'mock').toLowerCase() === 'real' ? 'REAL' : 'MOCK') as 'REAL' | 'MOCK',
    baseUrl: str('HUAWEI_BASE_URL', 'https://intl.fusionsolar.huawei.com/thirdData'),
    authorizedIp: process.env.HUAWEI_AUTHORIZED_IP || '',
  },

  sync: {
    cronEnabled: bool('SYNC_CRON_ENABLED', false),
    hour: num('SYNC_CRON_HOUR', 2),
    minute: num('SYNC_CRON_MINUTE', 30),
  },

  bootstrap: {
    adminEmail: str('BOOTSTRAP_ADMIN_EMAIL', 'admin@retse.com.gt'),
    adminName: str('BOOTSTRAP_ADMIN_NAME', 'Administrador del Sistema'),
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
    seedDemo: bool('SEED_DEMO_DATA', !isProduction),
    demoPassword: process.env.DEMO_USER_PASSWORD || '',
  },

  paths: {
    root: rootDir,
    migrations: path.join(rootDir, 'database', 'migrations'),
    templates: path.join(rootDir, 'database', 'seeds'),
  },
};

export type Env = typeof env;
