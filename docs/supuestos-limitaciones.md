# Supuestos, decisiones y limitaciones

Documento de cierre del proyecto. Registra lo que se asumió, lo que se decidió y lo que
queda explícitamente fuera del alcance de esta versión.

---

## 1. Supuestos adoptados

| # | Supuesto | Fundamento |
|---|---|---|
| 1 | El nombre del proyecto (`proyectos.nombre`) es **único** y coincide con la columna `Planta` del Excel histórico | Es el único identificador disponible en el formato histórico para resolver la planta |
| 2 | La producción del formato histórico es **mensual** y se ancla al día 1 del mes | El archivo de referencia solo aporta año y mes |
| 3 | Un mes puede tener **a lo sumo una tarifa vigente** (`BORRADOR` o `APROBADA`) por proyecto | Evita ambigüedad sobre cuál aplicar; las anuladas se conservan como historial |
| 4 | El “coordinador” es un usuario **operativo** con el permiso `tarifas.gestionar` | El alcance lo indica explícitamente: no se crea un cuarto rol global |
| 5 | La zona horaria operativa es fija: `America/Guatemala` (UTC−6, sin horario de verano) | Guatemala no aplica horario de verano; permite tratar fechas civiles sin hora |
| 6 | El redondeo monetario es **half-up**: kWh a 4 decimales, tarifa a 6, valor a 4 y se presenta con 2 | Criterio documentado y verificado en `tests/tarifas.test.ts` |
| 7 | No se acepta producción con **fecha futura** ni **kWh negativos** | No existe una regla empresarial documentada que los justifique |
| 8 | Cuando coexisten dos niveles de detalle en un mes, prevalece el **detalle por inversor** | Es el dato más granular y verificable |
| 9 | Cuando coexisten lecturas diarias y un cierre mensual del mismo inversor y mes, prevalece la **diaria** | Misma lógica: el dato más granular gana |
| 10 | La comparación por defecto es contra el **periodo anterior equivalente** | El alcance prohíbe inventar una “producción esperada” inexistente |
| 11 | Los factores de equivalencia ambiental son **configurables** con unidad y fuente declaradas | El alcance prohíbe constantes ocultas |
| 12 | El servicio Python **no accede a MySQL** | Mantiene una única capa de reglas de negocio y autorización |

---

## 2. Decisiones de implementación relevantes

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Cookies `HttpOnly` + CSRF *double submit* | JWT en `localStorage` | El alcance exige no guardar tokens sensibles en `localStorage` |
| bcrypt (coste 12) | Argon2id | El alcance admite ambos; bcrypt evita dependencias nativas y despliega igual en Windows, Linux y Docker |
| Migraciones SQL con runner propio | ORM con migraciones generadas | Esquema auditable, sin capa de abstracción que oculte restricciones |
| Consultas parametrizadas con `mysql2` | ORM completo | Control explícito de las CTEs de anti-doble-conteo |
| Columna generada `clave_vigente` | Índice parcial | MySQL no admite índices parciales |
| Campo `secuencia` en `produccion` | Descartar filas repetidas | Varias filas de una planta y mes **no** son duplicados automáticos |
| Lote de importación persistido en disco entre previsualización y confirmación | Reprocesar el archivo al confirmar | Garantiza que lo confirmado es idéntico a lo previsualizado |
| PDF con PDFKit | Navegador sin cabeza (Puppeteer) | Menor superficie de ataque y despliegue mucho más liviano |

---

## 3. Limitaciones conocidas de esta versión

1. **Integración Huawei en modo simulado por defecto.** La activación real depende de
   credenciales válidas y de que Huawei autorice previamente la IP pública del VPS.
   El adaptador real está implementado y probado contra un doble que respeta su contrato,
   pero **no ha sido ejecutado contra la plataforma real del fabricante**.
2. **Un solo fabricante.** Existe la interfaz `AdaptadorFabricante`, pero solo se
   implementa `HuaweiSmartPVMSAdapter`, tal como exige el alcance.
3. **Mapeo fila a inversor en la importación.** La opción `MAPEAR` requiere que el
   archivo incluya una columna `Inversor`/`Serial`. La asignación manual fila por fila
   desde la interfaz no está implementada; el asistente lo indica al usuario.
4. **Sin portal público para clientes finales.** Excluido explícitamente del alcance.
5. **Sin inteligencia artificial ni redes neuronales.** Excluido explícitamente.
6. **Pruebas end-to-end a nivel de API.** El recorrido completo se verifica contra el API
   real y MySQL real (`tests/e2e/recorrido.test.ts`). No hay automatización de navegador;
   la interfaz se verificó manualmente.
7. **Exportación de reportes limitada a PDF, CSV y XLSX.** No hay generación de documentos
   Word ni envío automático por correo.
8. **Un solo idioma.** Toda la aplicación está en español, sin infraestructura de
   internacionalización.
9. **Sincronización programada de alcance global.** El horario se configura por
   integración, no por proyecto individual.
10. **Sin alta disponibilidad.** El diseño asume un único VPS. No hay replicación de
    MySQL ni balanceo entre varias instancias del backend.

---

## 4. Pasos para activar la integración Huawei real

1. Obtener la IP pública de salida del VPS: `curl -s https://api.ipify.org`.
2. Solicitar a Huawei el **registro y autorización** de esa IP para la cuenta northbound.
3. Definir en el entorno del servicio Python: `HUAWEI_USERNAME`, `HUAWEI_SYSTEM_CODE`,
   `HUAWEI_AUTHORIZED_IP` y `HUAWEI_MODE=real`.
4. Reiniciar el servicio Python.
5. En la aplicación: **Integración Huawei → Configurar → Modo REAL**, registrando la IP
   autorizada (el sistema rechaza el cambio si falta).
6. Ejecutar **Probar conexión**. El adaptador compara la IP de salida real con la
   autorizada y avisa si no coinciden.
7. Sincronizar un rango corto y verificar los datos antes de habilitar el modo programado.

> Mientras el modo sea `MOCK`, todos los registros generados quedan etiquetados como
> **simulados** en la interfaz y en el historial de ejecuciones, y el sistema advierte
> que no deben mezclarse con datos reales sin confirmación.

---

## 5. Riesgos residuales

| Riesgo | Mitigación implementada | Acción pendiente del cliente |
|---|---|---|
| Cambio de la API del fabricante | Códigos de error traducidos y adaptador aislado | Revisar el adaptador ante avisos de Huawei |
| Cambio de la IP pública del VPS | El sistema detecta y reporta `IP_NO_AUTORIZADA` | IP estática y reautorizar ante cambios |
| Archivos históricos con nombres de planta inconsistentes | El asistente permite asignar la planta manualmente | Homologar los nombres en el origen |
| Pérdida del servidor | Respaldo diario automático con verificación | Copiar los respaldos a un destino externo |
| Meses sin tarifa que distorsionen reportes | Bloqueo del cierre y advertencia destacada en reportes | Registrar las tarifas dentro del mes corriente |
| Doble conteo por mezcla de niveles | Resolución automática y aviso al usuario | Definir por proyecto un único nivel de detalle |

---

## 6. Deuda técnica sugerida para próximas versiones

- Automatización de pruebas de interfaz con navegador (Playwright).
- Mapeo fila a inversor desde la propia interfaz del asistente de importación.
- Notificaciones por correo ante sincronizaciones fallidas o meses sin tarifa.
- Exportación de reportes programada y envío automático a gerencia.
- Replicación de MySQL y despliegue en más de una instancia.
