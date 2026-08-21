# Modelo de datos

Motor: **MySQL 8.0+** · Juego de caracteres `utf8mb4` · Zona horaria `America/Guatemala`.
El esquema se aplica mediante las migraciones versionadas de `database/migrations/`.

---

## 1. Diagrama entidad-relación

```
        ┌──────────────┐          ┌────────────────┐         ┌──────────────────┐
        │   clientes   │1        *│    proyectos   │1       *│    inversores    │
        │──────────────│──────────│────────────────│─────────│──────────────────│
        │ id_cliente PK│          │ id_proyecto PK │         │ id_inversor   PK │
        │ nombre       │          │ id_cliente  FK │         │ id_proyecto   FK │
        │ nit       UQ │          │ nombre      UQ │         │ marca, modelo    │
        │ ubicacion    │          │ tipo_proyecto  │         │ tipo_conexion    │
        │ activo       │          │ capacidad_kwp  │         │ serial_externo   │
        └──────────────┘          │ activo         │         │ id_api        FK │
                                  └───────┬────────┘         └────────┬─────────┘
                                          │                           │
                     ┌────────────────────┼───────────────────┐       │
                     │                    │                   │       │
              ┌──────▼───────┐   ┌────────▼─────────┐  ┌──────▼───────▼──────────┐
              │ tarifas_kwh  │   │ proyecciones_kwh │  │       produccion        │
              │──────────────│   │──────────────────│  │─────────────────────────│
              │ id_tarifa PK │   │ id_proyeccion PK │  │ id_produccion        PK │
              │ id_proyecto  │   │ id_proyecto   FK │  │ id_proyecto          FK │
              │ anio, mes    │   │ anio, mes        │  │ id_inversor      FK NULL│
              │ costo_kwh    │   │ proyeccion_kwh   │  │ nivel_detalle           │
              │ estado       │   │ estado           │  │ fecha, anio, mes        │
              │ clave_vigente│UQ │ clave_vigente  UQ│  │ granularidad            │
              └──────┬───────┘   └──────────────────┘  │ kwh, origen, secuencia  │
                     │                                 │ id_tarifa            FK │
                     └────────────── valoriza ─────────│ costo_kwh_aplicado      │
                                                       │ valor_q                 │
              ┌───────────────────┐                    │ estado_valorizacion     │
              │ cierres_mensuales │                    │ id_historico         FK │
              │ id_proyecto/anio/mes UQ                │ id_sync              FK │
              └───────────────────┘                    │ inversor_key   generada │
                                                       └───────┬─────────────────┘
                                                               │
                                          ┌────────────────────┴───────────┐
                                          │                                │
                                 ┌────────▼────────┐             ┌─────────▼─────────┐
                                 │   historicos    │            *│ produccion_ajustes│
                                 │─────────────────│             └───────────────────┘
                                 │ id_historico PK │
                                 │ formato         │1     *┌────────────────────┐
                                 │ nivel_detalle   │───────│ historico_errores  │
                                 │ hash_sha256     │       └────────────────────┘
                                 │ estado, totales │
                                 └─────────────────┘

  ┌──────────────────┐1     *┌───────────────────┐         ┌──────────────────┐
  │ apis_fabricante  │───────│ sincronizaciones  │         │     reportes     │
  │──────────────────│       │───────────────────│         │──────────────────│
  │ id_api        PK │       │ id_sync        PK │         │ id_reporte    PK │
  │ marca, endpoint  │       │ estado, modo      │         │ id_usuario    FK │
  │ ip_autorizada    │       │ rango, metricas   │         │ tipo, parametros │
  │ secreto_ref      │       │ codigo_error      │         │ cobertura_tarif. │
  │ modo, estado     │       └───────────────────┘         └──────────────────┘
  └──────────────────┘

  ┌───────────┐1  *┌──────────────┐*  1┌───────────┐   ┌──────────────────┐
  │   roles   │────│ rol_permisos │────│  permisos │   │  refresh_tokens  │
  └─────┬─────┘    └──────────────┘    └─────┬─────┘   │ token_hash    UQ │
        │1                                   │*        └────────┬─────────┘
        │                                    │                  │*
        │*      ┌──────────────────┐         │                  │1
  ┌─────▼───────┴──┐   ┌───────────▼─────────┴──┐      ┌────────▼─────────┐
  │    usuarios    │───│   usuario_permisos     │      │    auditoria     │
  │ id_usuario  PK │*  │ otorgado (1 = otorga,  │      │ accion, entidad  │
  │ email       UQ │  *│            0 = revoca) │      │ antes / despues  │
  │ password_hash  │   └────────────────────────┘      └──────────────────┘
  └────────────────┘

  ┌────────────────┐   ┌────────────┐
  │ configuracion  │   │  bloqueos  │   (parámetros y concurrencia)
  └────────────────┘   └────────────┘
```

---

## 2. Relaciones principales

- Un **cliente** posee muchos **proyectos**.
- Un **proyecto** pertenece a un cliente y contiene muchos **inversores**.
- Un **inversor** pertenece a un proyecto y genera muchos registros de **producción**.
- Un **inversor** puede tener muchos **históricos** de importación.
- Un **inversor Huawei** se vincula con una configuración autorizada de **API**.
- Un **usuario** puede generar muchos **reportes**.
- Un **proyecto** tiene a lo sumo una **tarifa** vigente y una **proyección** vigente por año y mes.

---

## 3. Tablas del núcleo

### 3.1 `produccion` — la tabla crítica

| Columna | Tipo | Notas |
|---|---|---|
| `id_produccion` | BIGINT UNSIGNED PK | |
| `id_proyecto` | INT UNSIGNED FK | Siempre presente |
| `id_inversor` | INT UNSIGNED FK NULL | Nulo en el consolidado de proyecto |
| `nivel_detalle` | ENUM | `POR_INVERSOR` \| `PROYECTO_CONSOLIDADO` |
| `fecha` | DATE | En granularidad mensual se ancla al día 1 |
| `anio`, `mes` | SMALLINT / TINYINT | Redundantes por rendimiento en agregaciones |
| `granularidad` | ENUM | `DIARIA` \| `MENSUAL` |
| `kwh` | DECIMAL(18,4) | Energía. `CHECK (kwh >= 0)` |
| `origen` | ENUM | `MANUAL` \| `HUAWEI_API` \| `AJUSTE` |
| `secuencia` | SMALLINT | Distingue componentes del mismo periodo |
| `id_tarifa` | INT UNSIGNED FK NULL | Trazabilidad de la tarifa aplicada |
| `costo_kwh_aplicado` | DECIMAL(12,6) NULL | Copia histórica del costo |
| `valor_q` | DECIMAL(18,4) NULL | `kwh × costo_kwh_aplicado` |
| `estado_valorizacion` | ENUM | `VALORIZADA` \| `PENDIENTE_DE_TARIFA` |
| `inversor_key` | INT generada STORED | `COALESCE(id_inversor, 0)` |

**Regla de unicidad documentada** (garantiza la idempotencia de cargas y sincronizaciones):

```sql
UNIQUE KEY uk_produccion (id_proyecto, inversor_key, fecha, granularidad, origen, secuencia)
```

No se usa únicamente `proyecto + año + mes` porque el archivo histórico de referencia
contiene **más de una fila válida** para una misma planta y mes.

**Restricción de coherencia**

```sql
CHECK ((nivel_detalle = 'POR_INVERSOR'         AND id_inversor IS NOT NULL)
    OR (nivel_detalle = 'PROYECTO_CONSOLIDADO' AND id_inversor IS NULL))
```

### 3.2 `tarifas_kwh` y `proyecciones_kwh`

Ambas usan la misma técnica para permitir **historial de anulaciones** conservando la
unicidad de lo vigente:

```sql
clave_vigente VARCHAR(40) GENERATED ALWAYS AS
    (IF(estado = 'ANULADA', NULL, CONCAT(id_proyecto,'-',anio,'-',mes))) STORED,
UNIQUE KEY uk_tarifa_vigente (clave_vigente)
```

MySQL admite múltiples `NULL` en un índice `UNIQUE`, de modo que puede haber muchas
tarifas anuladas para el mismo periodo pero **a lo sumo una vigente** (`BORRADOR` o `APROBADA`).

> **Nota de MySQL:** `id_proyecto` es columna base de una columna generada `STORED`, por lo
> que su clave foránea **no puede** usar `CASCADE` ni `SET NULL`. Se deja en `RESTRICT`:
> un proyecto con tarifas no se elimina, se desactiva.

### 3.3 `historicos` e `historico_errores`

`historicos` registra: proyecto/inversor, formato, nivel de detalle, nombre original,
**nombre seguro generado por el servidor**, `hash_sha256`, tamaño, usuario, estado
(`PENDIENTE`, `VALIDANDO`, `VALIDADO`, `PROCESANDO`, `COMPLETADO`, `COMPLETADO_CON_ERRORES`,
`FALLIDO`, `RECHAZADO`, `EXPIRADO`), totales de filas, fechas mínima y máxima, política de
duplicados y las decisiones tomadas por el usuario.

### 3.4 `apis_fabricante`

Contempla `id_api`, `marca`, `endpoint`, `ip_autorizada`, `estado`, modo (`MOCK`/`REAL`),
tiempos de espera y fechas de última prueba y sincronización.
**Nunca almacena credenciales**: `secreto_ref` solo indica *dónde* viven (por ejemplo
`env:HUAWEI_SYSTEM_CODE`).

### 3.5 Tablas auxiliares

| Tabla | Propósito |
|---|---|
| `refresh_tokens` | Sesiones renovables. Solo el hash del token; rotación con detección de reúso |
| `usuario_permisos` | Permisos individuales: `otorgado = 1` otorga, `0` revoca |
| `auditoria` | Bitácora con datos antes/después, motivo, IP y correlación |
| `configuracion` | Parámetros con tipo, unidad, fuente y bandera `editable` |
| `bloqueos` | Bloqueo cooperativo con expiración para evitar operaciones concurrentes |
| `cierres_mensuales` | Cierre y reapertura de periodos por proyecto |
| `produccion_ajustes` | Historial de correcciones manuales de producción |
| `_migraciones` | Control de migraciones aplicadas con su hash |

---

## 4. Índices

Además de las claves primarias y únicas:

```
produccion:   ix_prod_fecha, ix_prod_periodo(id_proyecto, anio, mes),
              ix_prod_inversor_fecha, ix_prod_valorizacion,
              ix_prod_nivel(id_proyecto, nivel_detalle, granularidad, fecha)
tarifas_kwh:  ix_tarifas_periodo(id_proyecto, anio, mes, estado)
auditoria:    ix_aud_fecha, ix_aud_usuario, ix_aud_entidad, ix_aud_accion
historicos:   ix_hist_proyecto, ix_hist_estado, ix_hist_fecha, ix_hist_hash
```

---

## 5. Estrategia de baja

El sistema privilegia la **desactivación lógica** (`activo = 0`) para conservar la
trazabilidad. La eliminación física solo procede cuando el registro no tiene ninguna
relación; en caso contrario el API responde `eliminado: false` y explica el motivo.

---

## 6. Migraciones

| Archivo | Contenido |
|---|---|
| `001_core.sql` | Roles, permisos, usuarios, sesiones, auditoría, configuración y bloqueos |
| `002_negocio.sql` | Clientes, proyectos, inversores y APIs de fabricante |
| `003_energia.sql` | Tarifas, proyecciones, cierres, producción y ajustes |
| `004_importacion.sql` | Históricos, errores, sincronizaciones y reportes |
| `005_catalogos.sql` | Catálogos obligatorios: roles, permisos y parámetros |

El runner registra cada archivo con su hash. Si una migración ya aplicada se modifica,
el sistema advierte en el log: **cree una migración nueva en lugar de editar una existente**.
