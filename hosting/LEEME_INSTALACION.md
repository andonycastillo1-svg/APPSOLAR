# Instalación de APPSOLAR en el hosting (cPanel)

Este paquete es independiente del entorno de desarrollo. Corre como **una sola
aplicación Node.js** (sirve la API y la pantalla web) y **solo necesita MySQL**.
No requiere Python, Docker ni acceso por terminal.

## Requisitos en el hosting

| Requisito | Cómo comprobarlo |
|---|---|
| **Setup Node.js App** (Node.js Selector) | Aparece en cPanel, sección *Software*. Versión 18 o superior. |
| **MySQL Databases** | Sección *Bases de datos*. |
| **Dominio con HTTPS** | AutoSSL / Let's Encrypt activo en el dominio. |

Si el cPanel no tiene "Setup Node.js App", este sistema **no puede correr ahí**:
pida al proveedor que lo habilite o use un plan con Node.js.

## Pasos

### 1. Crear la base de datos
1. cPanel → **MySQL Databases** → crear base (ej. `appsolar`).
2. Crear un usuario con contraseña fuerte y **agregarlo a la base con TODOS los privilegios**.
3. Anotar los tres nombres completos (cPanel les antepone el prefijo de la cuenta,
   ej. `micuenta_appsolar`, `micuenta_appuser`).

### 2. Subir los archivos
1. cPanel → **Administrador de archivos**. Ubicarse en el directorio de la cuenta
   (`/home/micuenta/`), **NO dentro de `public_html`**.
2. Crear la carpeta `appsolar` y subir `APPSOLAR_hosting.zip` dentro; **Extract**.
3. Crear también la carpeta `appsolar_datos/uploads` (fuera de `public_html`).

### 3. Crear la aplicación Node.js
cPanel → **Setup Node.js App** → *Create Application*:

| Campo | Valor |
|---|---|
| Node.js version | 18 o superior |
| Application mode | **Production** |
| Application root | `appsolar` |
| Application URL | el dominio (o subdominio) |
| Application startup file | `app.js` |

### 4. Variables de entorno
Abrir `env.hosting.ejemplo`, completar **todos** los valores `CAMBIE_...` y cargarlos
en la sección *Environment variables* de la aplicación (o guardar el archivo como
`.env` dentro de `appsolar/`). Puntos clave:

- `DB_HOST=localhost` y los tres datos de la base del paso 1.
- `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET`: distintos, 64+ caracteres.
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`: serán el primer usuario.
- `UPLOAD_DIR`: ruta absoluta de `appsolar_datos/uploads`.
- `APP_PUBLIC_URL` y `CORS_ORIGINS`: `https://su-dominio`.
- `HUAWEI_USERNAME` y `HUAWEI_SYSTEM_CODE` de la cuenta Northbound.

### 5. Instalar y arrancar
1. En la pantalla de la aplicación: **Run NPM Install**.
2. **Restart**.
3. Abrir el dominio. En el primer arranque el sistema crea las tablas y el
   administrador inicial automáticamente (`AUTO_MIGRATE=true`).

### 6. Después del primer ingreso
1. Entrar con el administrador y **cambiar su contraseña**.
2. En *Integración*: modo **REAL** y **Probar conexión**.
3. Crear clientes, proyectos e inversores (con su serial); el código de estación
   de Huawei se descubre solo en la primera sincronización.

## Seguridad (revisar antes de publicar)

- La aplicación y `appsolar_datos` están **fuera de `public_html`**: ningún archivo
  del sistema es accesible directamente desde el navegador.
- El archivo `.env` (si se usa) queda en `appsolar/`, fuera del sitio público.
- No suba el zip ni el `.env` a repositorios ni lo comparta por chat/correo.
- El dominio debe abrir **solo por https** (activar *Force HTTPS Redirect* en cPanel → Dominios).
- Dejar `SEED_DEMO_DATA=false` y no crear usuarios de prueba.
- Respaldos: cPanel → **Backup** (base de datos y carpeta `appsolar_datos`), y
  probar al menos una vez la restauración.
- La contraseña de la cuenta Northbound se rota desde FusionSolar; luego actualizar
  `HUAWEI_SYSTEM_CODE` y reiniciar la aplicación.

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| La app no inicia / error 503 | Falta o está mal una variable `CAMBIE_...`; revisar el log de la aplicación en cPanel. |
| "Access denied" a MySQL | Usuario sin privilegios sobre la base, o nombre sin el prefijo de la cuenta. |
| Pantalla en blanco | `APP_PUBLIC_URL` / `CORS_ORIGINS` no coinciden con el dominio real. |
| Huawei "IP no autorizada" | Pedir al administrador de FusionSolar autorizar la IP **del hosting** (no la de su oficina). |
| Huawei "credenciales inválidas" | `HUAWEI_USERNAME` / `HUAWEI_SYSTEM_CODE` incorrectos (la clave con `#` va entre comillas). |
