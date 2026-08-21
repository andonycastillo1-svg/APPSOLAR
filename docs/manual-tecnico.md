# Manual técnico

Guía para quien mantiene o extiende el sistema.

---

## 1. Convenciones del código

| Aspecto | Convención |
|---|---|
| Idioma | Identificadores, comentarios y mensajes **en español** |
| Acentos en código | Se evitan en identificadores y literales SQL; el texto visible al usuario sí los usa |
| Contrato de respuesta | `{ ok: true, datos, meta }` / `{ ok: false, error }` |
| Errores | Se lanzan con `errores.*` de `utils/errors.ts`; el manejador central los traduce |
| Validación | Zod en el límite del API (`validarCuerpo`, `validarConsulta`) |
| Acceso a datos | `query`, `queryOne`, `execute`, `withTransaction` de `db/pool.ts` |
| Autorización | `requierePermiso(...)` en la definición de cada ruta |

---

## 2. Cómo agregar un endpoint

1. Cree o ubique el módulo en `backend/src/modules/<dominio>/`.
2. Defina el esquema Zod de entrada.
3. Declare la ruta con su permiso:

```ts
router.post(
  '/',
  requierePermiso(PERMISOS.MI_PERMISO),
  validarCuerpo(esquema),
  asyncHandler(async (req, res) => {
    // ... reglas de negocio
    await auditarDesdeRequest(req, {
      accion: 'MI_ACCION',
      entidad: 'mi_tabla',
      idEntidad: id,
      despues: datos,
    });
    creado(res, { id, mensaje: 'Operación realizada correctamente.' });
  }),
);
```

4. Monte el router en `app.ts`.
5. Documente la operación en `docs/openapi.json`.
6. Agregue el caso a `tests/rbac.test.ts` (acceso permitido y denegado) y una prueba
   funcional en el archivo de pruebas del dominio.

---

## 3. Cómo agregar un permiso

1. Añádalo a `backend/src/config/permisos.ts` (constante y asignación por rol).
2. Cree una **migración nueva** que lo inserte en `permisos` y en `rol_permisos`.
   Nunca edite una migración ya aplicada.
3. La prueba `rbac.test.ts` verificará automáticamente que código y base coincidan.
4. Documéntelo en `docs/matriz-permisos.md`.

---

## 4. Cómo agregar una migración

```bash
# El nombre determina el orden de aplicación.
touch database/migrations/006_mi_cambio.sql
```

Reglas:

- Nombre `NNN_descripcion.sql` con numeración correlativa.
- Cambios **aditivos** siempre que sea posible, para permitir actualizar sin interrupción.
- El runner registra el hash de cada archivo. Si modifica uno ya aplicado, el sistema lo
  advierte en el log: cree una migración nueva en su lugar.

Recuerde la restricción de MySQL: una clave foránea sobre una columna que es **base de una
columna generada `STORED`** no puede usar `CASCADE`, `SET NULL` ni `SET DEFAULT`.

---

## 5. Motor de valorización

`backend/src/services/valorizacion.ts`

| Función | Uso |
|---|---|
| `buscarTarifaAprobada` | Tarifa vigente de un proyecto/año/mes |
| `CacheTarifas` | Evita repetir consultas al valorizar lotes grandes |
| `calcularValorizacion` | Devuelve `id_tarifa`, `costo_kwh_aplicado`, `valor_q` y estado |
| `recalcularPendientes` | Valoriza los registros pendientes tras aprobar una tarifa |
| `analizarImpacto` | Cálculo previo obligatorio antes de corregir una tarifa usada |
| `recalcularPorTarifa` | Aplica la corrección a todos los registros afectados |
| `exigirMesAbierto` | Bloquea operaciones sobre periodos cerrados |
| `coberturaTarifaria` | Indicador de meses con y sin tarifa del periodo |

**Invariante:** `valor_q` **siempre** se deriva de `kwh × costo_kwh_aplicado`.
Ninguna ruta permite editarlo directamente.

---

## 6. Consultas agregadas y anti-doble-conteo

`backend/src/services/consultasProduccion.ts`

Las agregaciones usan dos CTEs:

```sql
WITH niveles AS (            -- ¿el mes tiene detalle por inversor?
  SELECT id_proyecto, anio, mes, MAX(nivel_detalle = 'POR_INVERSOR') AS tiene_detalle
    FROM produccion WHERE activo = 1 GROUP BY id_proyecto, anio, mes
),
granularidades AS (          -- ¿el inversor tiene lecturas diarias ese mes?
  SELECT id_proyecto, inversor_key, anio, mes, MAX(granularidad = 'DIARIA') AS tiene_diaria
    FROM produccion WHERE activo = 1 GROUP BY id_proyecto, inversor_key, anio, mes
)
```

Y filtran con `SIN_DOBLE_CONTEO` y `SIN_MEZCLA_GRANULARIDAD`.

> Si agrega una consulta agregada nueva, **debe** incluir ambas condiciones o los totales
> quedarán inflados. La prueba correspondiente vive en `tests/importaciones.test.ts`.

---

## 7. ETL de importación

`backend/src/services/etl.ts`

```
leerArchivo()          CSV o XLSX → filas canónicas + problemas por fila
detectarFormato()      NORMALIZADO | HISTORICO_EXCEL a partir de los encabezados
agruparPorPeriodo()    Agrupa por planta/año/mes y marca los grupos ambiguos
plantilla*()           Genera las plantillas y el archivo de ejemplo con errores
```

Para admitir un nuevo alias de columna, agréguelo a `ALIAS_NORMALIZADO` o
`ALIAS_HISTORICO`. El sistema ya normaliza acentos, mayúsculas y separadores.

El flujo `preview → confirm` persiste el lote normalizado en
`storage/uploads/lote_<id>.json`, de modo que **lo confirmado es exactamente lo
previsualizado**. El archivo se elimina al confirmar y los lotes no confirmados en 24 h
se marcan como `EXPIRADO` por la tarea de mantenimiento.

---

## 8. Adaptador de fabricante

`python-service/app/adapters/`

Para incorporar otro fabricante en el futuro:

1. Cree `app/adapters/<marca>.py` heredando de `AdaptadorFabricante`.
2. Implemente `probar_conexion()` y `obtener_produccion()`, devolviendo
   `RegistroCanonico` (serial, fecha ISO, kWh, granularidad).
3. Traduzca los códigos de fallo propios del fabricante a los códigos estables del
   sistema (`CREDENCIALES_INVALIDAS`, `IP_NO_AUTORIZADA`, `LIMITE_API`, `TIEMPO_AGOTADO`,
   `FORMATO_INESPERADO`, `SERVICIO_NO_DISPONIBLE`, `CONFIGURACION_INCOMPLETA`).
4. Registre la marca en `apis_fabricante` y en la fábrica del servicio.

**Nunca** implemente scraping ni métodos no autorizados: el alcance lo prohíbe
explícitamente.

---

## 9. Frontend

```
lib/api.ts        Cliente HTTP: CSRF, renovación automática ante 401, descargas
lib/auth.tsx      Contexto de sesión y helpers `puede()` / `puedeAlguno()`
lib/formato.ts    kWh, kWp, quetzales, porcentajes, fechas dd/mm/aaaa
hooks/useListado  Búsqueda, filtros, orden y paginación resueltos en el servidor
components/       Estados, Campos, Tabla, Gráficas y Layout accesibles
pages/            Una página por módulo del alcance
```

Reglas de la interfaz:

- Toda pantalla contempla carga, vacío, error, sin permisos y éxito.
- `puede()` **solo** adapta la interfaz; la autorización real la aplica el servidor.
- Toda gráfica incluye su alternativa en tabla.
- Las operaciones destructivas piden confirmación explícita.
- Nunca se etiqueta la generación acumulada como kWp.

---

## 10. Pruebas

```bash
npm test                                    # suite completa
npx vitest run tests/tarifas.test.ts        # un archivo
npx vitest watch                            # modo interactivo
```

- `tests/setup.ts` fija las variables de entorno **antes** de cargar los módulos de `src/`
  (los imports de ES se elevan, por eso no basta con asignarlas dentro del archivo de prueba).
- `tests/utils/entorno.ts` ofrece `prepararBaseDeDatos`, `iniciarSesion`, `comoUsuario`,
  `crearDatosBase` y `levantarPythonSimulado`.
- Las pruebas se ejecutan en un solo proceso y de forma secuencial porque comparten la
  base `appsolar_test`.
- El servicio Python se sustituye por un doble HTTP que respeta su mismo contrato, lo que
  permite probar éxito, credenciales inválidas, IP no autorizada y tiempo agotado de forma
  determinista.

Al agregar una funcionalidad, agregue como mínimo: el caso feliz, un caso de validación
rechazada y el caso de autorización denegada.

---

## 11. Depuración

| Necesidad | Cómo |
|---|---|
| Seguir una petición concreta | Busque su `correlationId` en el log (se muestra al usuario en los errores) |
| Ver el SQL que falla | El manejador central traduce los códigos de MySQL; el detalle técnico va al log |
| Verificar permisos efectivos | `GET /api/auth/me` o **Mi perfil** en la interfaz |
| Revisar qué cambió y quién | **Auditoría → Ver cambios** (datos antes/después) |
| Estado de los servicios | `GET /api/health/detalle` o **Estado de servicios** |

---

## 12. Errores frecuentes al desarrollar

| Síntoma | Causa |
|---|---|
| `Falta la variable de entorno obligatoria` | `.env` incompleto o valor truncado por un `#` sin comillas |
| Migración falla con “Cannot add foreign key constraint” | FK con `CASCADE`/`SET NULL` sobre columna base de una columna generada `STORED` |
| Totales inflados en una consulta nueva | Falta aplicar `SIN_DOBLE_CONTEO` y `SIN_MEZCLA_GRANULARIDAD` |
| `valor_q` en `null` inesperadamente | El mes no tiene tarifa aprobada: es el comportamiento correcto |
| 403 en una ruta recién creada | Falta el permiso en `permisos.ts` **y** en la migración de catálogos |
| Las cookies no llegan en desarrollo | Use el proxy de Vite (`/api`), no `http://localhost:4000` directo |
