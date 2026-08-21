/**
 * Configuracion previa a la carga de los modulos de la aplicacion.
 * Debe ejecutarse ANTES de cualquier import de `src/`, porque `config/env.ts`
 * lee las variables de entorno al ser importado por primera vez.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin.pruebas@retse.com.gt';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Pruebas.2026#Admin';
process.env.HUAWEI_MODE = 'mock';
process.env.BCRYPT_ROUNDS = '6';
process.env.CORS_ORIGINS = 'http://localhost:5173';
