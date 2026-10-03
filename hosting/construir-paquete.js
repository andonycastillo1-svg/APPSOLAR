/**
 * Genera el paquete listo para subir al hosting (cPanel / Node.js).
 *
 *   node hosting/construir-paquete.js
 *
 * No modifica el entorno local: compila en hosting/paquete/ y deja el zip en
 * hosting/APPSOLAR_hosting.zip. frontend/dist y backend/dist no se tocan.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.resolve(__dirname, '..');
const destino = path.join(__dirname, 'paquete');
const zip = path.join(__dirname, 'APPSOLAR_hosting.zip');
const bin = (nombre) => path.join(raiz, 'node_modules', '.bin', process.platform === 'win32' ? `${nombre}.cmd` : nombre);

function ejecutar(comando, args, opciones = {}) {
  execFileSync(comando, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opciones });
}

console.log('1/6 Limpiando carpeta del paquete...');
fs.rmSync(destino, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.mkdirSync(destino, { recursive: true });

console.log('2/6 Compilando el backend...');
ejecutar(bin('tsc'), ['-p', 'tsconfig.json', '--outDir', path.join(destino, 'dist'), '--sourceMap', 'false'], {
  cwd: path.join(raiz, 'backend'),
});

console.log('3/6 Compilando el frontend (misma direccion que el servidor)...');
ejecutar(bin('vite'), ['build', '--outDir', path.join(destino, 'frontend', 'dist'), '--emptyOutDir'], {
  cwd: path.join(raiz, 'frontend'),
  env: { ...process.env, VITE_API_URL: '' },
});

console.log('4/6 Copiando migraciones y documentacion...');
fs.cpSync(path.join(raiz, 'database', 'migrations'), path.join(destino, 'database', 'migrations'), { recursive: true });
fs.mkdirSync(path.join(destino, 'docs'), { recursive: true });
fs.copyFileSync(path.join(raiz, 'docs', 'openapi.json'), path.join(destino, 'docs', 'openapi.json'));

console.log('5/6 Generando package.json, app.js y archivos de ayuda...');
const pkgBackend = JSON.parse(fs.readFileSync(path.join(raiz, 'backend', 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(destino, 'package.json'),
  JSON.stringify(
    {
      name: 'appsolar',
      version: pkgBackend.version,
      private: true,
      main: 'app.js',
      scripts: {
        start: 'node app.js',
        migrar: 'node -e "process.env.APP_ROOT=__dirname;require(\'./dist/db/cli.js\')" migrate',
        admin: 'node -e "process.env.APP_ROOT=__dirname;require(\'./dist/db/cli.js\')" bootstrap',
      },
      engines: { node: '>=18' },
      // Versiones corregidas de seguridad solo para el despliegue: multer 2.x y
      // uuid >= 11.1.1 (dependencia indirecta de exceljs y node-cron).
      dependencies: { ...pkgBackend.dependencies, multer: '^2.4.0' },
      overrides: { uuid: '^11.1.1' },
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(destino, 'app.js'),
  `// Archivo de arranque para Passenger (cPanel > Setup Node.js App).
process.env.APP_ROOT = __dirname;
require('./dist/server.js');
`,
);

fs.copyFileSync(path.join(__dirname, 'env.hosting.ejemplo'), path.join(destino, 'env.hosting.ejemplo'));
fs.copyFileSync(path.join(__dirname, 'LEEME_INSTALACION.md'), path.join(destino, 'LEEME_INSTALACION.md'));

console.log('6/6 Comprimiendo el paquete...');
ejecutar('python', [path.join(__dirname, 'comprimir.py'), destino, zip]);

const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`\nListo: ${zip} (${mb} MB)`);
