# Arquitectura del sistema

**Sistema Centralizado de Monitoreo Energético y Análisis de Producción Solar para Dispositivos Inversores**
Uso interno de Retse, S.A.

---

## 1. Visión general

La plataforma centraliza información energética que hoy vive dispersa en plataformas de fabricantes,
archivos Excel y registros históricos. **Complementa** las herramientas oficiales de los fabricantes;
no las sustituye, y solo consume APIs autorizadas.

```
                        ┌──────────────────────────────────────────┐
                        │            Navegador (usuario)            │
                        │   React + TypeScript · español · WCAG AA  │
                        └────────────────────┬─────────────────────┘
                                             │ HTTPS
                                             │ cookies HttpOnly + token CSRF
                        ┌────────────────────▼─────────────────────┐
                        │        Nginx (proxy inverso, TLS)         │
                        │   Único punto expuesto a Internet         │
                        └────────────────────┬─────────────────────┘
                                             │ HTTP interno
                        ┌────────────────────▼─────────────────────┐
                        │      Backend Node.js + TypeScript         │
                        │  Autenticación · RBAC · reglas de negocio │
                        │  ETL de archivos · reportes · auditoría    │
                        └───────┬──────────────────────┬────────────┘
                                │                      │
              consultas         │                      │  HTTP interno
              parametrizadas    │                      │  (token de servicio)
                                │                      │
                   ┌────────────▼─────────┐   ┌────────▼──────────────────┐
                   │       MySQL 8         │   │  Servicio Python (FastAPI)│
                   │  Datos + auditoría    │   │  Adaptador Huawei SmartPVMS│
                   │  Solo red privada     │   │  Solo red privada          │
                   └───────────────────────┘   └────────┬──────────────────┘
                                                        │ HTTPS saliente
                                                        │ (IP autorizada)
                                              ┌─────────▼──────────┐
                                              │ Huawei SmartPVMS   │
                                              │ API northbound     │
                                              └────────────────────┘
```

**Regla de exposición:** solo Nginx escucha en Internet. MySQL y el servicio Python
únicamente aceptan conexiones desde la red privada del servidor.

---

## 2. Separación de responsabilidades

| Capa | Responsabilidad | Lo que **no** hace |
|---|---|---|
| **React** (`frontend/`) | Presentación, validación de interacción, estados visuales, accesibilidad, ocultar opciones sin permiso | No decide autorizaciones ni ejecuta reglas de negocio |
| **Node.js** (`backend/`) | Autenticación, autorización (RBAC), reglas de negocio, valorización, ETL, reportes, auditoría | No habla directamente con el fabricante |
| **MySQL** (`database/`) | Persistencia, restricciones de integridad, unicidad e índices | No contiene lógica de aplicación ni secretos en claro |
| **Python** (`python-service/`) | Autenticación y consulta a Huawei SmartPVMS, normalización al formato canónico | No accede a MySQL ni aplica reglas de negocio |

> Ocultar una opción en la interfaz **nunca** sustituye la autorización del servidor.
> Cada endpoint verifica los permisos efectivos del usuario en cada petición.

---

## 3. Estructura del repositorio

```
APPSOLAR/
├── backend/                  API REST y lógica de negocio (Node.js + TypeScript)
│   ├── src/
│   │   ├── config/           Entorno, logger y catálogo de permisos
│   │   ├── db/               Pool, migrador, CLI y datos semilla
│   │   ├── middleware/       Autenticación, CSRF, RBAC y manejo de errores
│   │   ├── modules/          Un directorio por dominio (auth, tarifas, importaciones…)
│   │   ├── services/         Valorización, ETL, archivos, sincronización, exportación
│   │   ├── jobs/             Tareas programadas (sincronización y mantenimiento)
│   │   └── utils/            Fechas, números, errores y contrato HTTP
│   └── tests/                Pruebas unitarias, de integración y end-to-end
├── frontend/                 Interfaz React + TypeScript
│   └── src/{components,pages,hooks,lib,styles}
├── python-service/           Adaptador Huawei (FastAPI)
│   └── app/adapters/         Contrato común + HuaweiSmartPVMSAdapter
├── database/
│   ├── migrations/           Esquema versionado (SQL)
│   ├── seeds/                Plantillas y archivos de ejemplo
│   └── scripts/              Respaldo y restauración
├── docs/                     Esta documentación + OpenAPI
├── infra/                    Docker Compose, Nginx y unidades systemd
└── storage/uploads/          Archivos cargados (fuera del árbol público)
```

---

## 4. Flujos principales

### 4.1 Autenticación y sesión

1. `POST /api/auth/login` valida credenciales con bcrypt (coste 12).
2. Se emiten dos cookies `HttpOnly`: acceso (JWT, 15 min) y refresco (opaco, 7 días).
   El refresco se guarda **solo como hash SHA-256** en la base de datos.
3. Una cookie adicional `as_csrf`, legible por el frontend, implementa el patrón
   *double submit*: toda petición que modifica estado debe repetir su valor en `x-csrf-token`.
4. `POST /api/auth/refresh` **rota** el refresco. Reutilizar uno ya rotado invalida
   toda la familia de sesiones (defensa contra robo de token).
5. Al desactivar un usuario o cambiar su rol se revocan sus sesiones activas.

### 4.2 Valorización monetaria

```
registro de producción (kwh, fecha)
        │
        ├─► se busca la tarifa APROBADA del proyecto para (año, mes) de la fecha
        │
        ├─ existe ──► valor_q = kwh × costo_kwh   [se guarda id_tarifa y costo aplicado]
        │             estado = VALORIZADA
        │
        └─ no existe ► valor_q = NULL
                       estado = PENDIENTE_DE_TARIFA   ← los kWh se conservan intactos
```

En rangos multi-mes **se valoriza registro por registro y luego se suma**. Nunca se
multiplica el total del rango por una sola tarifa. Al aprobar una tarifa faltante se
recalculan únicamente los registros pendientes de ese proyecto y mes.

### 4.3 Prevención del doble conteo

La producción puede existir en dos niveles y dos granularidades. Sumar ambos duplicaría
la energía, por lo que las consultas agregadas resuelven cuál prevalece:

| Situación | Prevalece | Se ignora |
|---|---|---|
| Un mes tiene detalle por inversor y consolidado de proyecto | `POR_INVERSOR` | El consolidado de ese mes |
| Un inversor tiene lecturas diarias y un cierre mensual del mismo mes | `DIARIA` | El registro `MENSUAL` |

Ambas reglas se implementan con CTEs en `services/consultasProduccion.ts` y los periodos
afectados se reportan al usuario en el tablero y en las consultas, nunca en silencio.

### 4.4 Importación de históricos (ETL)

```
1 destino → 2 plantilla → 3 archivo → 4 validar → 5 decisiones → 6 confirmar → 7 resumen
                                        │                            │
                                  (no toca datos)          (una sola transacción)
```

La previsualización guarda el lote normalizado en disco y crea el registro en `historicos`
con estado `VALIDADO`. La confirmación reutiliza **exactamente** ese lote, de modo que lo
confirmado es idéntico a lo previsualizado. Si algo falla, la transacción se revierte por
completo y el lote queda `FALLIDO`.

### 4.5 Sincronización Huawei

```
React → POST /api/production/sync (backend)
         ├─ valida sesión, rol, proyecto, inversor y configuración
         ├─ adquiere bloqueo de concurrencia
         ├─ POST /huawei/production → servicio Python
         │        └─ autentica y consulta SmartPVMS desde la IP autorizada
         │        └─ transforma al formato canónico
         ├─ revalida en Node (serial conocido, fecha válida, kWh ≥ 0, mes abierto)
         ├─ inserta/actualiza de forma idempotente en MySQL
         ├─ registra la ejecución con métricas y errores
         └─ libera el bloqueo y responde
```

---

## 5. Decisiones de diseño relevantes

| Decisión | Motivo |
|---|---|
| Cookies `HttpOnly` en lugar de `localStorage` | El token de sesión queda fuera del alcance de cualquier XSS |
| Migraciones en SQL plano con runner propio | El esquema es auditable y no depende de un ORM |
| `dateStrings: true` en el pool MySQL | Evita desplazamientos de zona horaria entre Node y MySQL |
| Unicidad con columna generada `clave_vigente` | MySQL no admite índices parciales; permite historial de tarifas anuladas |
| Campo `secuencia` en producción | Distingue componentes legítimos del mismo periodo sin tratarlos como duplicados |
| Servicio Python separado | Aísla la integración del fabricante y permite autorizar una sola IP saliente |
| Factores ambientales en `configuracion` | Nunca son constantes ocultas: declaran unidad y fuente |

---

## 6. Observabilidad

- **Logs estructurados** (pino) con redacción obligatoria de contraseñas, tokens y cookies.
- **Identificador de correlación** por petición, devuelto en `x-correlation-id` y mostrado
  al usuario ante errores para facilitar el soporte.
- **Auditoría** en base de datos de toda acción relevante, con datos antes/después.
- **Estado de servicios** en `/api/health/detalle` para administradores.

---

## 7. Documentos relacionados

- [Modelo de datos](modelo-datos.md)
- [Matriz de roles y permisos](matriz-permisos.md)
- [Manual de usuario por rol](manual-usuario.md)
- [Guía de despliegue](despliegue.md)
- [Operación, respaldo y restauración](operacion.md)
- [Supuestos y limitaciones](supuestos-limitaciones.md)
- [Especificación OpenAPI](openapi.json)
