# Operación: respaldo, restauración y monitoreo

---

## 1. Respaldo

### Automático

El temporizador de systemd `appsolar-respaldo.timer` ejecuta un respaldo diario a las
**01:30 (America/Guatemala)**.

```bash
sudo systemctl list-timers | grep appsolar
sudo systemctl start appsolar-respaldo.service   # ejecución manual inmediata
sudo tail -f /var/log/appsolar/respaldo.log
```

### Manual

```bash
cd /opt/appsolar
sudo -u appsolar ./database/scripts/respaldo.sh [directorio_destino]
```

### Qué se respalda

| Elemento | Archivo generado |
|---|---|
| Base de datos completa | `appsolar_AAAAMMDD_HHMMSS.sql.gz` |
| Huella de verificación | `appsolar_AAAAMMDD_HHMMSS.sql.gz.sha256` |
| Archivos de importación | `uploads_AAAAMMDD_HHMMSS.tar.gz` |

El volcado usa `--single-transaction`, por lo que **no bloquea** las tablas InnoDB y el
sistema puede seguir operando durante el respaldo. Al terminar se verifica la integridad
del archivo comprimido y se aplica la política de retención
(`RETENCION_DIAS`, 30 días por defecto).

### Recomendación de resguardo externo

El respaldo local no protege ante la pérdida del servidor. Copie los archivos a un
destino externo, por ejemplo:

```bash
rsync -avz --delete /var/backups/appsolar/ usuario@servidor-resguardo:/respaldos/appsolar/
```

---

## 2. Restauración

```bash
cd /opt/appsolar
sudo -u appsolar ./database/scripts/restaurar.sh \
  /var/backups/appsolar/appsolar_20260821_013000.sql.gz \
  /var/backups/appsolar/uploads_20260821_013000.tar.gz
```

El script:

1. Verifica la integridad y la huella SHA-256 del archivo.
2. **Exige escribir `RESTAURAR`** para continuar (no basta con `s/y`).
3. Crea un respaldo de seguridad del estado actual antes de sobrescribir.
4. Recrea el esquema y carga el volcado.
5. Restaura los archivos de importación si se indicó el segundo argumento.
6. Verifica el número de tablas restauradas.

Después de restaurar:

```bash
sudo -u appsolar npm run db:migrate        # aplica migraciones posteriores al respaldo
sudo systemctl restart appsolar-backend
curl -s https://monitoreo.retse.com.gt/health
```

### Ensayo periódico

Restaure el respaldo en un entorno de prueba al menos una vez por trimestre.
Un respaldo que nunca se ha restaurado no es un respaldo verificado.

---

## 3. Monitoreo

### Desde la aplicación

**Administración → Estado de servicios** (permiso `salud.ver`), actualizado cada 30 s:

- Semáforo de API, MySQL, servicio Python e integración Huawei.
- Tiempo en línea, memoria y versión de Node.
- Tamaño y número de tablas de la base.
- Última tarea programada, última sincronización y última importación.

### Desde el servidor

```bash
# Estado de los servicios
sudo systemctl status appsolar-backend appsolar-python nginx mysql --no-pager

# Registros en vivo
sudo journalctl -u appsolar-backend -f
sudo tail -f /var/log/appsolar/backend.log

# Con Docker
sudo docker compose -f /opt/appsolar/infra/docker-compose.yml ps
sudo docker compose -f /opt/appsolar/infra/docker-compose.yml logs -f backend
```

### Sonda externa

Configure el monitor institucional contra:

```
GET https://monitoreo.retse.com.gt/health
```

Responde `200` cuando el servicio está operativo y `503` cuando MySQL no está accesible.
Es una versión pública mínima: no revela detalles internos.

---

## 4. Registros (logs)

| Origen | Ubicación |
|---|---|
| Backend | `/var/log/appsolar/backend.log` |
| Servicio Python | `/var/log/appsolar/python.log` |
| Respaldos | `/var/log/appsolar/respaldo.log` |
| Nginx | `/var/log/nginx/appsolar_acceso.log`, `appsolar_error.log` |
| MySQL (consultas lentas) | `/var/lib/mysql/lento.log` |

Los registros del backend son **JSON estructurado** con redacción automática de
contraseñas, tokens y cookies. Cada línea incluye el `correlationId` de la petición, el
mismo que se muestra al usuario cuando ocurre un error.

Para investigar un incidente reportado por un usuario:

```bash
grep '<correlationId>' /var/log/appsolar/backend.log | jq .
```

Rotación: diaria, 30 archivos, comprimidos (`/etc/logrotate.d/appsolar`).

---

## 5. Tareas programadas de la aplicación

| Tarea | Horario | Descripción |
|---|---|---|
| Sincronización Huawei | Configurable (por defecto 02:30) | Solo se ejecuta si `sync.programada` está activo y la integración está `ACTIVA` |
| Mantenimiento | 03:15 | Elimina tokens vencidos y bloqueos expirados; marca como `EXPIRADO` los lotes de importación no confirmados en 24 h |

Ambas usan la zona horaria `America/Guatemala`. La sincronización programada se habilita
desde **Configuración → `sync.programada`** o desde la pantalla de integración.

---

## 6. Mantenimiento periódico sugerido

| Frecuencia | Tarea |
|---|---|
| Diaria | Revisar el estado de servicios y el resultado del respaldo |
| Semanal | Revisar la auditoría de acciones sensibles y las sincronizaciones fallidas |
| Mensual | Registrar y aprobar las tarifas del mes; cerrar el periodo contable |
| Mensual | Verificar que no queden registros `PENDIENTE_DE_TARIFA` |
| Trimestral | Ensayo de restauración; `npm audit` y actualización de dependencias |
| Anual | Cargar las proyecciones del año siguiente y revisar los factores ambientales |

---

## 7. Respuesta ante incidentes

**Sospecha de acceso indebido**

1. Desactive el usuario afectado (**Usuarios → Editar → Activo = no**). Esto revoca de
   inmediato todas sus sesiones.
2. Restablezca su contraseña.
3. Revise la auditoría filtrando por ese usuario y por `resultado = FALLO`.
4. Si hubo cambios indebidos, use la auditoría (datos antes/después) para revertirlos y
   deje constancia del motivo en cada corrección.

**Datos incorrectos en producción**

1. **No edite la base de datos directamente.** Use los flujos auditados de la aplicación.
2. Para un registro puntual: **Producción → Corregir**, con motivo.
3. Para una tarifa mal registrada: **Tarifas → Corregir**, revisando el análisis de impacto.
4. Si el periodo está cerrado, reábralo indicando el motivo y ciérrelo de nuevo al terminar.

**Sincronización fallida repetidamente**

Consulte el código de error en **Integración Huawei → Historial**:

| Código | Significado y acción |
|---|---|
| `CREDENCIALES_INVALIDAS` | Verificar `HUAWEI_USERNAME` / `HUAWEI_SYSTEM_CODE` |
| `IP_NO_AUTORIZADA` | La IP pública cambió: volver a registrarla ante Huawei |
| `LIMITE_API` | Reducir la ventana de sincronización o espaciar las ejecuciones |
| `TIEMPO_AGOTADO` | Revisar la conectividad saliente y aumentar `timeout_s` |
| `FORMATO_INESPERADO` | El fabricante cambió su API: revisar el adaptador |
| `SERVICIO_NO_DISPONIBLE` | El servicio Python no responde: `systemctl status appsolar-python` |
