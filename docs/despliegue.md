# Guía de despliegue

Servidor objetivo: **VPS con Ubuntu Server 22.04 LTS o superior**.
Publicación en un **subdominio institucional con HTTPS**.

---

## 1. Requisitos previos

| Componente | Versión mínima |
|---|---|
| Ubuntu Server | 22.04 LTS |
| Node.js | 20 LTS |
| MySQL | 8.0 |
| Python | 3.11 |
| Nginx | 1.22 |
| Docker + Compose *(opción A)* | 24 / v2 |

**Antes de empezar, tenga a mano:**

- El subdominio institucional apuntando (registro `A`) a la IP pública del VPS.
- La IP pública del VPS **registrada y autorizada ante Huawei** si va a activar la
  integración real. Hasta entonces el sistema opera en modo simulado.
- Credenciales `HUAWEI_USERNAME` y `HUAWEI_SYSTEM_CODE` de la cuenta northbound.

---

## 2. Preparación del servidor

```bash
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone America/Guatemala
sudo apt install -y git ufw

# Cortafuegos: solo SSH y HTTP/HTTPS quedan abiertos.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

> MySQL (3306) y el servicio Python (8000) **nunca** se abren en el cortafuegos.

Cree el usuario de servicio y los directorios:

```bash
sudo useradd --system --create-home --home-dir /opt/appsolar --shell /usr/sbin/nologin appsolar
sudo mkdir -p /var/log/appsolar /var/backups/appsolar
sudo chown -R appsolar:appsolar /opt/appsolar /var/log/appsolar /var/backups/appsolar
```

---

## 3. Obtener el código y configurar el entorno

```bash
sudo -u appsolar git clone <URL_DEL_REPOSITORIO> /opt/appsolar
cd /opt/appsolar
sudo -u appsolar cp .env.example .env
```

Genere secretos reales y edite `.env`:

```bash
openssl rand -hex 48   # JWT_ACCESS_SECRET
openssl rand -hex 48   # JWT_REFRESH_SECRET
openssl rand -hex 32   # PYTHON_SERVICE_TOKEN
```

Valores obligatorios en producción:

```ini
NODE_ENV=production
APP_PUBLIC_URL=https://monitoreo.retse.com.gt
CORS_ORIGINS=https://monitoreo.retse.com.gt
COOKIE_SECURE=true
TRUST_PROXY=1

DB_HOST=127.0.0.1
DB_USER=appsolar
DB_PASSWORD=<clave-fuerte>
DB_NAME=appsolar
DB_ROOT_PASSWORD=<clave-root>

JWT_ACCESS_SECRET=<64+ caracteres>
JWT_REFRESH_SECRET=<64+ caracteres>
PYTHON_SERVICE_TOKEN=<token interno>

BOOTSTRAP_ADMIN_EMAIL=admin@retse.com.gt
BOOTSTRAP_ADMIN_PASSWORD="<contraseña fuerte entre comillas>"
SEED_DEMO_DATA=false

HUAWEI_MODE=mock
```

> ⚠️ Encierre entre comillas cualquier valor que contenga `#`: sin ellas, el carácter
> inicia un comentario y la variable quedaría truncada.
>
> ⚠️ `SEED_DEMO_DATA=false` en producción. Los datos de demostración jamás deben
> convivir con datos reales.

```bash
sudo chmod 600 /opt/appsolar/.env
sudo chown appsolar:appsolar /opt/appsolar/.env
```

---

## 4. Opción A — Despliegue con Docker Compose (recomendado)

```bash
cd /opt/appsolar/infra
sudo docker compose --env-file ../.env up -d --build
sudo docker compose ps
```

El servicio `backend` aplica **las migraciones antes de arrancar** y crea el
administrador inicial. Ningún puerto de MySQL ni del servicio Python se publica.

Verificación:

```bash
curl -s http://localhost/health
sudo docker compose logs -f backend
```

---

## 5. Opción B — Despliegue con systemd (sin Docker)

### 5.1 MySQL

```bash
sudo apt install -y mysql-server
sudo mysql_secure_installation
```

Cree la base y un usuario con **privilegios mínimos** (sin `GRANT OPTION`, sin `DROP`
sobre otros esquemas):

```sql
CREATE DATABASE appsolar CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'appsolar'@'localhost' IDENTIFIED BY '<clave-fuerte>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, EXECUTE
   ON appsolar.* TO 'appsolar'@'localhost';
FLUSH PRIVILEGES;
```

Confirme que MySQL solo escucha localmente (`/etc/mysql/mysql.conf.d/mysqld.cnf`):

```ini
bind-address = 127.0.0.1
default-time-zone = '-06:00'
```

### 5.2 Backend y frontend

```bash
cd /opt/appsolar
sudo -u appsolar npm ci --no-audit --no-fund
sudo -u appsolar npm run build          # compila backend y frontend
sudo -u appsolar npm run db:migrate
sudo -u appsolar npm run --workspace backend db:bootstrap
```

### 5.3 Servicio Python

```bash
cd /opt/appsolar/python-service
sudo -u appsolar python3 -m venv .venv
sudo -u appsolar .venv/bin/pip install --no-cache-dir -r requirements.txt
```

### 5.4 Unidades de systemd

```bash
sudo cp /opt/appsolar/infra/systemd/appsolar-*.service /etc/systemd/system/
sudo cp /opt/appsolar/infra/systemd/appsolar-respaldo.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now appsolar-python appsolar-backend appsolar-respaldo.timer
sudo systemctl status appsolar-backend --no-pager
```

Ambos servicios tienen **reinicio automático** (`Restart=always`).

---

## 6. Nginx y HTTPS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp /opt/appsolar/infra/nginx/appsolar.conf     /etc/nginx/sites-available/appsolar
sudo cp /opt/appsolar/infra/nginx/proxy_comun.inc   /etc/nginx/conf.d/
sudo ln -sf /etc/nginx/sites-available/appsolar /etc/nginx/sites-enabled/appsolar
sudo rm -f /etc/nginx/sites-enabled/default
```

Reemplace `monitoreo.retse.com.gt` por el subdominio real y, en la opción B, cambie
`proxy_pass http://backend:4000` por `proxy_pass http://127.0.0.1:4000`.

```bash
sudo nginx -t
sudo certbot --nginx -d monitoreo.retse.com.gt
sudo systemctl reload nginx
```

Certbot instala la renovación automática. Verifíquela con:

```bash
sudo certbot renew --dry-run
```

---

## 7. Rotación de logs

```bash
sudo cp /opt/appsolar/infra/logrotate-appsolar /etc/logrotate.d/appsolar
sudo logrotate -d /etc/logrotate.d/appsolar   # simulación
```

---

## 8. Activar la integración Huawei real

1. Obtenga la IP pública de salida del servidor:
   ```bash
   curl -s https://api.ipify.org
   ```
2. Solicite a Huawei el **registro y la autorización de esa IP** para la cuenta
   northbound. Sin este paso el fabricante rechaza toda petición.
3. Complete en `.env` del servicio Python:
   ```ini
   HUAWEI_MODE=real
   HUAWEI_USERNAME=<usuario northbound>
   HUAWEI_SYSTEM_CODE=<system code>
   HUAWEI_AUTHORIZED_IP=<ip pública autorizada>
   ```
4. Reinicie el servicio Python.
5. En la aplicación: **Integración Huawei → Configurar**, cambie el modo a **REAL**,
   registre la IP autorizada y guarde.
6. Ejecute **Probar conexión** antes de la primera sincronización. El adaptador compara
   la IP de salida real con la autorizada y avisa si no coinciden.
7. Solo entonces active la **sincronización programada**.

> Las credenciales viven exclusivamente como variables de entorno del servicio Python.
> La base de datos guarda únicamente una referencia (`secreto_ref`), nunca el valor.

---

## 9. Verificación posterior al despliegue

```bash
curl -s https://monitoreo.retse.com.gt/health
```

Y desde la aplicación, como usuario administrativo:

- **Administración → Estado de servicios**: API, MySQL y servicio Python en verde.
- **Administración → Configuración**: parámetros cargados.
- Inicie sesión con el administrador inicial y **cambie su contraseña**.

Lista de comprobación de seguridad:

- [ ] `.env` con permisos `600` y propietario `appsolar`.
- [ ] `SEED_DEMO_DATA=false` y sin usuarios de demostración en la base.
- [ ] `COOKIE_SECURE=true` y el sitio responde solo por HTTPS.
- [ ] `CORS_ORIGINS` contiene únicamente el subdominio institucional.
- [ ] Puertos 3306 y 8000 cerrados desde el exterior (`sudo ss -tlnp`).
- [ ] Respaldo programado activo (`systemctl list-timers | grep appsolar`).

---

## 10. Actualización con mínima interrupción

```bash
cd /opt/appsolar

# 1. Respaldo previo obligatorio
sudo -u appsolar ./database/scripts/respaldo.sh

# 2. Traer los cambios
sudo -u appsolar git pull --ff-only

# 3. Dependencias y compilación (el servicio sigue en línea)
sudo -u appsolar npm ci --no-audit --no-fund
sudo -u appsolar npm run build

# 4. Migraciones (aditivas: no rompen la versión en ejecución)
sudo -u appsolar npm run db:migrate

# 5. Reinicio breve
sudo systemctl restart appsolar-backend
sudo systemctl restart appsolar-python

# 6. Verificación
curl -s https://monitoreo.retse.com.gt/health
```

Con Docker Compose:

```bash
cd /opt/appsolar/infra
sudo -u appsolar /opt/appsolar/database/scripts/respaldo.sh
sudo docker compose --env-file ../.env up -d --build
```

**Reversión:** si algo falla, vuelva al commit anterior, reconstruya y, solo si la
migración fue destructiva, restaure el respaldo con `database/scripts/restaurar.sh`.

---

## 11. Solución de problemas frecuentes

| Síntoma | Causa probable | Acción |
|---|---|---|
| `/health` responde 503 | MySQL no accesible | Revisar credenciales y `systemctl status mysql` |
| Estado de servicios muestra Python “no disponible” | El servicio no arrancó o el token no coincide | `journalctl -u appsolar-python -n 50` y verificar `PYTHON_SERVICE_TOKEN` |
| No se puede iniciar sesión y el navegador no guarda cookies | `COOKIE_SECURE=true` sin HTTPS | Completar la instalación del certificado |
| `IP_NO_AUTORIZADA` al sincronizar | La IP pública cambió o no está registrada | Volver al paso 8 |
| La carga de archivos falla con 413 | `client_max_body_size` menor que `MAX_UPLOAD_MB` | Ajustar Nginx |
| Error al aplicar una migración | Migración editada después de aplicarse | Crear una migración nueva; nunca editar una aplicada |
