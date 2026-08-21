#!/usr/bin/env bash
# =====================================================================
# Respaldo de la base de datos y de los archivos de importacion.
#
#   ./respaldo.sh [directorio_destino]
#
# Variables de entorno requeridas (normalmente desde el .env del servicio):
#   DB_HOST, DB_PORT, DB_NAME, DB_ROOT_USER, DB_ROOT_PASSWORD, UPLOAD_DIR
#
# Politica de retencion: se conservan los ultimos RETENCION_DIAS dias.
# =====================================================================
set -Eeuo pipefail

DESTINO="${1:-${BACKUP_DIR:-/var/backups/appsolar}}"
RETENCION_DIAS="${RETENCION_DIAS:-30}"
MARCA="$(date +%Y%m%d_%H%M%S)"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-appsolar}"
DB_USUARIO="${DB_ROOT_USER:-root}"
DB_CLAVE="${DB_ROOT_PASSWORD:-}"
UPLOAD_DIR="${UPLOAD_DIR:-/datos/uploads}"

registrar() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"; }

fallo() {
  registrar "ERROR en la linea $1. El respaldo NO se completo."
  exit 1
}
trap 'fallo $LINENO' ERR

if [ -z "$DB_CLAVE" ]; then
  registrar "ERROR: defina DB_ROOT_PASSWORD antes de ejecutar el respaldo."
  exit 1
fi

mkdir -p "$DESTINO"
registrar "Iniciando respaldo de '$DB_NAME' hacia '$DESTINO'."

# ---------------------------------------------------------------------
# 1. Volcado de la base de datos
#    --single-transaction  respalda sin bloquear las tablas InnoDB
#    --routines --events   incluye rutinas y eventos programados
#    --set-gtid-purged=OFF facilita la restauracion en otro servidor
# ---------------------------------------------------------------------
ARCHIVO_SQL="$DESTINO/${DB_NAME}_${MARCA}.sql.gz"

MYSQL_PWD="$DB_CLAVE" mysqldump \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USUARIO" \
  --single-transaction --quick --routines --events --triggers \
  --default-character-set=utf8mb4 \
  --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 > "$ARCHIVO_SQL"

TAMANO=$(du -h "$ARCHIVO_SQL" | cut -f1)
registrar "Base de datos respaldada: $(basename "$ARCHIVO_SQL") ($TAMANO)"

# ---------------------------------------------------------------------
# 2. Archivos de importacion
# ---------------------------------------------------------------------
if [ -d "$UPLOAD_DIR" ]; then
  ARCHIVO_TAR="$DESTINO/uploads_${MARCA}.tar.gz"
  tar -czf "$ARCHIVO_TAR" -C "$(dirname "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")"
  registrar "Archivos de importacion respaldados: $(basename "$ARCHIVO_TAR")"
else
  registrar "AVISO: no existe el directorio de cargas '$UPLOAD_DIR'; se omite."
fi

# ---------------------------------------------------------------------
# 3. Verificacion de integridad
# ---------------------------------------------------------------------
if gzip -t "$ARCHIVO_SQL"; then
  registrar "Verificacion de integridad correcta."
else
  registrar "ERROR: el archivo comprimido esta danado."
  exit 1
fi

sha256sum "$ARCHIVO_SQL" > "${ARCHIVO_SQL}.sha256"

# ---------------------------------------------------------------------
# 4. Retencion
# ---------------------------------------------------------------------
ELIMINADOS=$(find "$DESTINO" -maxdepth 1 -name "*.gz" -mtime "+${RETENCION_DIAS}" -print -delete | wc -l)
find "$DESTINO" -maxdepth 1 -name "*.sha256" -mtime "+${RETENCION_DIAS}" -delete
registrar "Retencion aplicada: ${ELIMINADOS} archivo(s) con mas de ${RETENCION_DIAS} dias eliminados."

registrar "Respaldo finalizado correctamente."
