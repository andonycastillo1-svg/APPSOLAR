# Modelo de datos

Motor: **MySQL 8.0+** · Juego de caracteres `utf8mb4` · Zona horaria `America/Guatemala`.
El esquema se aplica mediante las migraciones versionadas de `database/migrations/`.

---

## 1. Diagrama entidad-relación

```
  Jerarquía del negocio:   CLIENTE ─► PROYECTO ─► GRUPO ─► INVERSOR

        ┌──────────────┐        ┌────────────────┐      ┌──────────────────┐
        │   clientes   │1      *│    proyectos   │1    *│      grupos      │
        │──────────────│────────│────────────────│──────│──────────────────│
        │ id_cliente PK│        │ id_proyecto PK │      │ id_grupo      PK │
        │ nombre       │        │ id_cliente  FK │      │ id_proyecto   FK │
        │ nit       UQ │        │ nombre      UQ │      │ nombre           │
        │ ubicacion    │        │ tipo_proyecto  │      │ cantidad_inver-  │
        │ activo       │        │ capacidad_kwp  │      │  sores_declarada │
        └──────────────┘        │ activo         │      │ tiene_banco_bat. │
                                └───────┬────────┘      │ capacidad_bat_kwh│
                                        │               │ capacidad_kwp    │
                                        │               └────────┬─────────┘
                                        │                        │1
                                        │                        │*
                                        │               ┌────────▼─────────┐
                                        │               │    inversores    │
                                        │               │──────────────────│
                                        │               │ id_inversor   PK │
                                        │               │ id_proyecto   FK │
                                        │               │ id_grupo   FK NN │
                                        │               │ marca, modelo    │
                                        │               │ tipo_conexion    │
                                        │               │ serial_externo   │
                                        │               │ id_api        FK │
                                        │               └────────┬─────────┘
                     ┌──────────────────┼───────────────────┐    │
                     │                  │                   │    │
              ┌──────▼───────┐ ┌────────▼─────────┐  ┌──────▼────▼─────────────┐
              │ tarifas_kwh  │ │ proyecciones_kwh │  │       produccion        │
              │──────────────│ │──────────────────│  │─────────────────────────│
              │ id_tarifa PK │ │ id_proyeccion PK │  │ id_produccion        PK │
              │ id_proyecto  │ │ id_proyecto   FK │  │ id_proyecto          FK │
              │ anio         │ │ anio, mes        │  │ id_grupo         FK NULL│
              │ trimestre    │ │ proyeccion_kwh   │  │ id_inversor      FK NULL│
              │ costo_kwh    │ │ estado           │  │ nivel_detalle           │
              │ estado       │ │ clave_vigente  UQ│  │ fecha, anio, mes        │
              │ clave_vigente│UQ└──────────────────┘  │ granularidad            │
              └──────┬───────┘   TRIMESTRAL │ MENSUAL │ kwh, origen, secuencia  │
                     │                                 │ id_tarifa            FK │
                     └────────────── valoriza ─────────│ costo_kwh_aplicado      │
                                                       │ valor_q                 │
              ┌───────────────────┐                    │ estado_valorizacion     │
              │ cierres_mensuales │                    │ id_historico         FK │
              │ id_proyecto/anio/mes UQ                │ id_sync              FK │
              └───────────────────┘                    │ grupo_key      generada │
                                                       │ inversor_key   generada │
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
- Un **proyecto** pertenece a un cliente y se divide en muchos **grupos**.
- Un **grupo** pertenece a un proyecto y agrupa muchos **inversores** con sus seriales.
  Declara cuántos inversores debería tener (`cantidad_inversores_declarada`) y si cuenta
  con **banco de baterías**.
- Un **inversor** pertenece siempre a un grupo (`id_grupo` es **NOT NULL**) y genera muchos
  registros de **producción**.
- Un **inversor** puede tener muchos **históricos** de importación.
- Un **inversor Huawei** se vincula con una configuración autorizada de **API**.
- Un **usuario** puede generar muchos **reportes**.
- Un **proyecto** tiene a lo sumo una **tarifa vigente por año y trimestre** y una
  **proyección vigente por año y mes**.

> La **proyección anual repartida mes a mes es obligatoria al crear el proyecto**: es la base
> contra la que después se compara la generación real para saber si la planta cumple lo pactado.

---

## 3. Tablas del núcleo

### 3.1 `produccion` — la tabla crítica

| Columna | Tipo | Notas |
|---|---|---|
| `id_produccion` | BIGINT UNSIGNED PK | |
| `id_proyecto` | INT UNSIGNED FK | Siempre presente |
| `id_grupo` | INT UNSIGNED FK NULL | Grupo del registro; nulo solo en el consolidado de proyecto |
| `id_inversor` | INT UNSIGNED FK NULL | Nulo en los consolidados de grupo y de proyecto |
| `nivel_detalle` | ENUM | `POR_INVERSOR` \| `GRUPO_CONSOLIDADO` \| `PROYECTO_CONSOLIDADO` |
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
| `grupo_key` | INT generada STORED | `COALESCE(id_grupo, 0)` |
| `inversor_key` | INT generada STORED | `COALESCE(id_inversor, 0)` |

**Regla de unicidad documentada** (garantiza la idempotencia de cargas y sincronizaciones):

```sql
UNIQUE KEY uk_produccion
  (id_proyecto, grupo_key, inversor_key, fecha, granularidad, origen, secuencia)
```

No se usa únicamente `proyecto + año + mes` porque el archivo histórico de referencia
contiene **más de una fila válida** para una misma planta y mes.

**Restricción de coherencia de los tres niveles**

```sql
CHECK ((nivel_detalle = 'POR_INVERSOR'         AND id_inversor IS NOT NULL AND id_grupo IS NOT NULL)
    OR (nivel_detalle = 'GRUPO_CONSOLIDADO'    AND id_inversor IS NULL     AND id_grupo IS NOT NULL)
    OR (nivel_detalle = 'PROYECTO_CONSOLIDADO' AND id_inversor IS NULL     AND id_grupo IS NULL))
```

**Prevención del doble conteo en tres niveles**

Las consultas resuelven, por cada `(grupo, fecha)`, cuál es el nivel de mayor detalle
disponible y descartan los niveles superiores para ese mismo par. La resolución es **por
fecha y no por mes** de forma deliberada: así una carga manual de un día concreto nunca se
descarta porque ese mismo mes tenga detalle por inversor en otros días.

### 3.2 `tarifas_kwh` (TRIMESTRAL) y `proyecciones_kwh` (MENSUAL)

El costo del kWh se pacta **por trimestre calendario**: los tres meses de un trimestre
comparten siempre la misma tarifa. La proyección, en cambio, sigue siendo **mensual**.

| Columna de `tarifas_kwh` | Notas |
|---|---|
| `anio` | Año calendario |
| `trimestre` | `1..4`. `CHECK (trimestre BETWEEN 1 AND 4)` |
| `mes` | **Columna histórica**. Se conserva para auditar de qué mes provino cada tarifa consolidada por la migración `006`; ya no participa en la unicidad ni en la valorización |
| `costo_kwh` | `DECIMAL(12,6)`, `CHECK (costo_kwh >= 0)` |

Ambas tablas usan la misma técnica para permitir **historial de anulaciones** conservando la
unicidad de lo vigente:

```sql
-- tarifas_kwh (trimestral)
clave_vigente VARCHAR(40) GENERATED ALWAYS AS
    (IF(estado = 'ANULADA', NULL, CONCAT(id_proyecto,'-',anio,'-T',trimestre))) STORED,
UNIQUE KEY uk_tarifa_vigente (clave_vigente)

-- proyecciones_kwh (mensual)
clave_vigente VARCHAR(40) GENERATED ALWAYS AS
    (IF(estado = 'ANULADA', NULL, CONCAT(id_proyecto,'-',anio,'-',mes))) STORED
```

La tarifa aplicable a un registro de producción se resuelve como
`trimestre = CEIL(mes / 3)` sobre la fecha del propio registro.

MySQL admite múltiples `NULL` en un índice `UNIQUE`, de modo que puede haber muchas
tarifas anuladas para el mismo periodo pero **a lo sumo una vigente** (`BORRADOR` o `APROBADA`).

> **Nota de MySQL:** `id_proyecto` es columna base de una columna generada `STORED`, por lo
> que su clave foránea **no puede** usar `CASCADE` ni `SET NULL`. Se deja en `RESTRICT`:
> un proyecto con tarifas no se elimina, se desactiva.

### 3.3 `grupos`

Nivel intermedio de la jerarquía. Es la unidad sobre la que se carga producción manualmente
cuando el fabricante no entrega datos.

| Columna | Tipo | Notas |
|---|---|---|
| `id_grupo` | INT UNSIGNED PK | |
| `id_proyecto` | INT UNSIGNED FK | `RESTRICT`: un proyecto con grupos no se elimina |
| `nombre` | VARCHAR(120) | Único dentro del proyecto |
| `cantidad_inversores_declarada` | SMALLINT NULL | Cuántos equipos debería tener el grupo |
| `tiene_banco_baterias` | TINYINT(1) | |
| `capacidad_baterias_kwh` | DECIMAL(12,2) NULL | Solo válida si `tiene_banco_baterias = 1` |
| `capacidad_kwp` | DECIMAL(12,3) NULL | Potencia instalada del grupo |
| `ubicacion`, `observaciones` | VARCHAR | |
| `activo` | TINYINT(1) | Baja lógica |

El API compara `cantidad_inversores_declarada` con los inversores realmente registrados y
emite un **aviso** cuando no coinciden; nunca bloquea la operación por ello.

### 3.4 `historicos` e `historico_errores`

`historicos` registra: proyecto/inversor, formato, nivel de detalle, nombre original,
**nombre seguro generado por el servidor**, `hash_sha256`, tamaño, usuario, estado
(`PENDIENTE`, `VALIDANDO`, `VALIDADO`, `PROCESANDO`, `COMPLETADO`, `COMPLETADO_CON_ERRORES`,
`FALLIDO`, `RECHAZADO`, `EXPIRADO`), totales de filas, fechas mínima y máxima, política de
duplicados y las decisiones tomadas por el usuario.

### 3.5 `apis_fabricante`

Contempla `id_api`, `marca`, `endpoint`, `ip_autorizada`, `estado`, modo (`MOCK`/`REAL`),
tiempos de espera y fechas de última prueba y sincronización.
**Nunca almacena credenciales**: `secreto_ref` solo indica *dónde* viven (por ejemplo
`env:HUAWEI_SYSTEM_CODE`).

### 3.6 Tablas auxiliares

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
              ix_prod_nivel(id_proyecto, nivel_detalle, granularidad, fecha),
              ix_prod_grupo_periodo(id_grupo, anio, mes)
grupos:       ix_grupos_proyecto(id_proyecto), ix_grupos_activo(activo)
inversores:   ix_inversores_grupo(id_grupo)
tarifas_kwh:  ix_tarifas_periodo(id_proyecto, anio, mes, estado)  [historico]
              ix_tarifas_trimestre(id_proyecto, anio, trimestre, estado)
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
| `006_grupos_y_tarifa_trimestral.sql` | Tabla `grupos`, nivel `GRUPO_CONSOLIDADO`, tarifa **trimestral** y revalorización completa del histórico |

### Qué hace la migración `006`

1. Crea `grupos` y genera un **«Grupo principal»** por cada proyecto existente, al que asigna
   todos sus inversores; después vuelve `inversores.id_grupo` **NOT NULL**.
2. Añade `produccion.id_grupo` con su columna generada `grupo_key`, extiende
   `nivel_detalle` al tercer valor y rehace la clave única y el `CHECK`.
3. Añade `tarifas_kwh.trimestre` y **consolida** las tarifas mensuales existentes: por cada
   trimestre conserva la última tarifa aprobada y **anula** las demás dejando constancia del
   motivo, de modo que no se pierde ni un registro del histórico.
4. Reconstruye `clave_vigente` con el trimestre y **revaloriza toda la producción**: primero
   la deja pendiente y luego la vuelve a valorizar con la tarifa del trimestre que le
   corresponde.
5. Registra los parámetros `tarifa.periodicidad`, `tarifa.dias_aviso_trimestre`,
   `proyecto.exigir_proyeccion` y `grupo.avisar_inversores_faltantes`.

El runner registra cada archivo con su hash. Si una migración ya aplicada se modifica,
el sistema advierte en el log: **cree una migración nueva en lugar de editar una existente**.
