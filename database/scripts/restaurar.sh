#!/usr/bin/env bash
# =====================================================================
# Restauracion de la base de datos desde un respaldo.
#
#   ./restaurar.sh <archivo.sql.gz> [archivo_uploads.tar.gz]
#
# ADVERTENCIA: la restauracion SOBRESCRIBE la base de datos indicada en
# DB_NAME. El script exige una confirmacion escrita antes de continuar y
# crea un respaldo de seguridad previo.
# =====================================================================
set -Eeuo pipefail

ARCHIVO_SQL="${1:-}"
ARCHIVO_UPLOADS="${2:-}"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-appsolar}"
DB_USUARIO="${DB_ROOT_USER:-root}"
DB_CLAVE="${DB_ROOT_PASSWORD:-}"
UPLOAD_DIR="${UPLOAD_DIR:-/datos/uploads}"
DESTINO_SEGURIDAD="${BACKUP_DIR:-/var/backups/appsolar}"

registrar() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"; }

if [ -z "$ARCHIVO_SQL" ]; then
  echo "Uso: $0 <archivo.sql.gz> [archivo_uploads.tar.gz]"
  exit 1
fi

if [ ! -f "$ARCHIVO_SQL" ]; then
  registrar "ERROR: no se encontro el archivo '$ARCHIVO_SQL'."
  exit 1
fi

if [ -z "$DB_CLAVE" ]; then
  registrar "ERROR: defina DB_ROOT_PASSWORD antes de restaurar."
  exit 1
fi

# ---------------------------------------------------------------------
# 1. Verificacion previa del archivo
# ---------------------------------------------------------------------
registrar "Verificando la integridad de '$ARCHIVO_SQL'."
gzip -t "$ARCHIVO_SQL" || { registrar "ERROR: archivo danado."; exit 1; }

if [ -f "${ARCHIVO_SQL}.sha256" ]; then
  sha256sum -c "${ARCHIVO_SQL}.sha256" || { registrar "ERROR: la huella no coincide."; exit 1; }
  registrar "Huella SHA-256 verificada."
fi

# ---------------------------------------------------------------------
# 2. Confirmacion explicita
# ---------------------------------------------------------------------
echo
echo "  Se va a SOBRESCRIBIR la base de datos: $DB_NAME ($DB_HOST:$DB_PORT)"
echo "  Origen del respaldo:                   $ARCHIVO_SQL"
echo
read -r -p "Escriba exactamente RESTAURAR para continuar: " CONFIRMACION
if [ "$CONFIRMACION" != "RESTAURAR" ]; then
  registrar "Operacion cancelada por el usuario."
  exit 1
fi

# ---------------------------------------------------------------------
# 3. Respaldo de seguridad del estado actual
# ---------------------------------------------------------------------
mkdir -p "$DESTINO_SEGURIDAD"
PREVIO="$DESTINO_SEGURIDAD/antes_de_restaurar_$(date +%Y%m%d_%H%M%S).sql.gz"
registrar "Creando respaldo de seguridad del estado actual."

MYSQL_PWD="$DB_CLAVE" mysqldump \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USUARIO" \
  --single-transaction --quick --routines --events --triggers \
  --default-character-set=utf8mb4 --set-gtid-purged=OFF \
  "$DB_NAME" 2>/dev/null | gzip -9 > "$PREVIO" || registrar "AVISO: no habia base previa que respaldar."

# ---------------------------------------------------------------------
# 4. Restauracion
# ---------------------------------------------------------------------
registrar "Restaurando la base de datos."

MYSQL_PWD="$DB_CLAVE" mysql \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USUARIO" \
  -e "DROP DATABASE IF EXISTS \`$DB_NAME\`;
      CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

gunzip -c "$ARCHIVO_SQL" | MYSQL_PWD="$DB_CLAVE" mysql \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USUARIO" \
  --default-character-set=utf8mb4 "$DB_NAME"

registrar "Base de datos restaurada."

# ---------------------------------------------------------------------
# 5. Archivos de importacion (opcional)
# ---------------------------------------------------------------------
if [ -n "$ARCHIVO_UPLOADS" ] && [ -f "$ARCHIVO_UPLOADS" ]; then
  registrar "Restaurando los archivos de importacion."
  mkdir -p "$(dirname "$UPLOAD_DIR")"
  tar -xzf "$ARCHIVO_UPLOADS" -C "$(dirname "$UPLOAD_DIR")"
  registrar "Archivos de importacion restaurados en '$UPLOAD_DIR'."
fi

# ---------------------------------------------------------------------
# 6. Verificacion posterior
# ---------------------------------------------------------------------
TABLAS=$(MYSQL_PWD="$DB_CLAVE" mysql --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USUARIO" \
  -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME';")
registrar "Verificacion: la base restaurada contiene $TABLAS tabla(s)."

registrar "Restauracion finalizada. Respaldo del estado anterior en: $PREVIO"
registrar "Ejecute 'npm run db:migrate' para aplicar migraciones posteriores al respaldo."
