# Sistema Centralizado de Monitoreo Energético y Análisis de Producción Solar

· Aplicación web interna para centralizar, consultar y analizar la
información energética de los proyectos fotovoltaicos administrados por la empresa.

La plataforma reúne datos hoy dispersos en plataformas de fabricantes, archivos Excel y
registros históricos; reduce el tiempo de consulta, mejora la trazabilidad, permite
comparar proyectos e inversores y genera reportes técnicos, comerciales y gerenciales
homogéneos.

> Complementa las herramientas oficiales de los fabricantes; **no las sustituye**.
> Solo consume APIs autorizadas.

---

## Contenido

- [Tecnologías](#tecnologías)
- [Puesta en marcha local](#puesta-en-marcha-local)
- [Usuarios de demostración](#usuarios-de-demostración)
- [Comandos disponibles](#comandos-disponibles)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Pruebas](#pruebas)
- [Reglas de negocio clave](#reglas-de-negocio-clave)
- [Seguridad](#seguridad)
- [Documentación](#documentación)

---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Recharts |
| Backend | Node.js 20 + TypeScript + Express + Zod |
| Base de datos | MySQL 8 |
| Integración y ETL especializado | Python 3.11 + FastAPI |
| Documentación de API | OpenAPI 3.0 (`docs/openapi.json`) |
| Pruebas | Vitest + Supertest sobre MySQL real |
| Despliegue | Ubuntu Server 22.04 · Nginx · Docker Compose o systemd |

---

## Puesta en marcha local

### Requisitos

- Node.js **20 LTS** o superior (probado también en 18.20)
- MySQL **8.0** en ejecución
- Python **3.11** (solo si desea ejecutar el servicio de integración)

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar el entorno

```bash
cp .env.example .env
```

Edite `.env` y complete al menos:

```ini
DB_USER=root
DB_PASSWORD=<su-clave-de-mysql>
DB_ROOT_PASSWORD=<su-clave-de-mysql>

JWT_ACCESS_SECRET=<64 caracteres aleatorios>
JWT_REFRESH_SECRET=<64 caracteres aleatorios>
PYTHON_SERVICE_TOKEN=<token interno>

BOOTSTRAP_ADMIN_EMAIL=admin@retse.com.gt
BOOTSTRAP_ADMIN_PASSWORD="<contrasena-fuerte-de-su-eleccion>"

SEED_DEMO_DATA=true
DEMO_USER_PASSWORD="<contrasena-para-los-usuarios-demo>"
```

> ⚠️ **Encierre entre comillas** cualquier valor que contenga `#`. Sin ellas, ese carácter
> inicia un comentario y la variable quedaría truncada.
>
> Genere secretos reales con `openssl rand -hex 48`.

### 3. Crear la base de datos con datos de demostración

```bash
npm run db:reset
```

Este comando borra y recrea el esquema, aplica las migraciones, crea el administrador
inicial y siembra datos ficticios claramente identificados con el prefijo `DEMO`.

Para un entorno **sin** datos de demostración:

```bash
npm run db:migrate
npm run --workspace backend db:bootstrap
```

### 4. Ejecutar la aplicación

En dos terminales:

```bash
npm run dev:backend     # API en http://localhost:4000
npm run dev:frontend    # Interfaz en http://localhost:5173
```

O ambos a la vez:

```bash
npm run dev
```

Abra **http://localhost:5173**.

### 5. Servicio de integración Huawei (opcional en desarrollo)

```bash
cd python-service
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Sin este servicio la aplicación funciona con normalidad; solo la sincronización Huawei
quedará marcada como no disponible en **Estado de servicios**.

### 6. Alternativa: un solo servicio

```bash
npm run build                          # compila backend y frontend
npm run --workspace backend start      # sirve API + interfaz en :4000
```

---

## Usuarios de demostración

Creados solo cuando `SEED_DEMO_DATA=true`. Todos usan el valor de `DEMO_USER_PASSWORD`.

| Correo | Rol | Para qué sirve |
|---|---|---|
| `demo.admin@retse.com.gt` | Administrativo | Todo: usuarios, catálogos, aprobación de tarifas, auditoría |
| `demo.operativo@retse.com.gt` | Operativo | Inversores, carga de históricos, sincronización |
| `demo.coordinador@retse.com.gt` | Operativo **+ `tarifas.gestionar`** | Registrar tarifas trimestrales (coordinador) |
| `demo.gerencia@retse.com.gt` | Gerencial | Solo lectura, comparaciones y reportes |

El administrador inicial real es el definido en `BOOTSTRAP_ADMIN_EMAIL`.

**Los datos sembrados incluyen deliberadamente** dos clientes, tres proyectos (PPA, EPC y
autoconsumo), cuatro **grupos de inversores** (uno de ellos con banco de baterías), cinco
inversores (manuales y Huawei), tarifas **trimestrales** que cambian de un trimestre a otro
con **el trimestre en curso sin tarifa** para demostrar el aviso de actualización trimestral,
proyecciones de doce meses, producción de dos años, una **carga manual de una semana
completa** en el grupo que perdió la conexión con el fabricante, importaciones exitosas y con
errores, y ejecuciones Huawei simuladas (una correcta y una fallida por IP no autorizada).

---

## Comandos disponibles

| Comando | Descripción |
|---|---|
| `npm run dev` | Backend y frontend en modo desarrollo |
| `npm run build` | Compila ambos para producción |
| `npm run db:migrate` | Crea el esquema y aplica las migraciones pendientes |
| `npm run db:seed` | Administrador inicial + datos de demostración |
| `npm run db:reset` | Borra, recrea, migra y siembra (bloqueado en producción) |
| `npm run --workspace backend db:bootstrap` | Solo el administrador inicial |
| `npm run --workspace backend db:plantillas` | Regenera las plantillas de `database/seeds/` |
| `npm test` | Suite completa de pruebas del backend |
| `npm run test:e2e` | Solo el recorrido de punta a punta |
| `npm run lint` | Análisis estático del backend |

---

## Estructura del repositorio

```
backend/          API REST, reglas de negocio, ETL, reportes y pruebas
frontend/         Interfaz React en español, accesible y responsive
python-service/   Adaptador Huawei SmartPVMS (FastAPI), interno
database/
  migrations/     Esquema versionado en SQL
  seeds/          Plantillas CSV/XLSX y archivo de ejemplo con errores
  scripts/        respaldo.sh y restaurar.sh
docs/             Arquitectura, modelo de datos, manuales, OpenAPI y despliegue
infra/            Docker Compose, Nginx, systemd y rotación de logs
storage/uploads/  Archivos cargados (fuera del árbol público)
```

---

## Pruebas

```bash
npm test
```

La suite trabaja sobre una base **real** (`appsolar_test`), que se crea desde cero con las
migraciones de producción. No se simula la base de datos.

```
tests/autenticacion.test.ts   Sesión, bloqueo, rotación de tokens, CSRF, contraseñas
tests/rbac.test.ts            Matriz de permisos endpoint por endpoint y por rol
tests/tarifas.test.ts         Valorización trimestral, impacto, recálculo, cierre y aviso
tests/grupos.test.ts          Jerarquía proyecto/grupo/inversor, proyección del alta y
                              carga manual de rangos cuando falla la conexión
tests/importaciones.test.ts   ETL: formatos, validaciones, decisiones, duplicados, rollback
tests/huawei.test.ts          Sincronización, idempotencia y errores diferenciados
tests/analisis.test.ts        Proyecciones, agregaciones, comparaciones y reportes
tests/seguridad.test.ts       Inyección, archivos, secretos, cabeceras y CORS
tests/e2e/recorrido.test.ts   Recorrido completo exigido en el alcance
```

Resultado de la última ejecución: **168 pruebas, 9 archivos, todas correctas.**

---

## Reglas de negocio clave

**Jerarquía del negocio**

```
CLIENTE ─► PROYECTO ─► GRUPO ─► INVERSOR
```

Un proyecto se divide en **grupos** y cada grupo agrupa varios inversores con sus seriales.
Cada grupo declara cuántos inversores debería tener y si cuenta con **banco de baterías**;
el sistema avisa cuando lo declarado no coincide con lo registrado, sin bloquear la
operación. Todo inversor pertenece a un grupo.

**Proyección pactada desde el alta**

La **proyección anual repartida mes a mes es obligatoria al crear el proyecto**. Es el
compromiso pactado desde el inicio y la base contra la que después se compara la generación
real para saber si la planta cumple. Proyecto, proyección y grupos se crean en una sola
transacción.

**Valorización monetaria (tarifa TRIMESTRAL)**

El costo del kWh se pacta **por trimestre calendario**: los tres meses de un trimestre
comparten siempre la misma tarifa. Cada registro se valoriza con la tarifa **aprobada** del
trimestre de su propia fecha: `valor_q = kwh × costo_kwh`. En rangos multi-trimestre se
valoriza registro por registro y luego se suma; nunca se multiplica el total del rango por
una sola tarifa.

Si un trimestre no tiene tarifa aprobada, **los kWh se conservan intactos** y el registro
queda como `PENDIENTE_DE_TARIFA`. No se usa cero ni la tarifa del trimestre anterior. Al
aprobar la tarifa faltante, el sistema recalcula únicamente los registros pendientes de ese
trimestre.

El sistema **avisa** cuando el trimestre en curso no tiene tarifa aprobada, y con
anticipación configurable (`tarifa.dias_aviso_trimestre`, por omisión 15 días) cuando el
siguiente tampoco la tiene. El aviso aparece en el tablero y en la pantalla de tarifas.

**Datos que el fabricante no entregó**

Si un grupo de inversores pierde la conexión durante un rango de fechas, el operador puede
**cargar esa energía manualmente** para que el histórico quede completo. El sistema muestra
los días faltantes de cada grupo, reparte la cifra capturada por día y guarda el resultado
como consolidado del grupo, con motivo obligatorio y auditoría. Repetir la carga no duplica
nada, y mezclar un relleno diario con un cierre mensual del mismo mes se **bloquea** salvo
confirmación expresa.

**Prevención del doble conteo (tres niveles)**

| Situación | Prevalece | Se ignora en los totales |
|---|---|---|
| Detalle por inversor + consolidado de grupo en la misma fecha | `POR_INVERSOR` | El consolidado del grupo |
| Datos con grupo + consolidado de proyecto en la misma fecha | El nivel con grupo | El consolidado de proyecto |
| Lecturas diarias + cierre mensual del mismo inversor y mes | `DIARIA` | El registro mensual |

La resolución es **por grupo y por fecha**, nunca por mes: así una carga manual de un día
concreto nunca se descarta porque ese mismo mes tenga detalle por inversor en otros días.

El sistema informa siempre estos casos; nunca los resuelve en silencio.

**Varias filas de una planta en el mismo mes**

No son duplicados automáticos. El asistente exige decidir: **SUMAR**, **COMPONENTES**,
**MAPEAR** a inversores o **RECHAZAR** el grupo. La decisión queda auditada.

**Correcciones**

Corregir una tarifa ya utilizada exige análisis de impacto, motivo, confirmación explícita
y el permiso `tarifas.recalcular`; el recálculo alcanza a los tres meses del trimestre. Se
conserva la auditoría antes/después. El cierre contable sigue siendo **mensual**: un mes
cerrado no admite cambios sin reapertura autorizada con motivo.

---

## Seguridad

- Contraseñas con **bcrypt** (coste 12) y política de complejidad verificada.
- Sesión en cookies **`HttpOnly`, `Secure`, `SameSite`**; el token nunca va a `localStorage`.
- **CSRF** por double submit cookie en toda operación que modifica estado.
- **Rotación de refresh tokens** con detección de reúso; revocación al desactivar usuarios.
- Validación y normalización de entradas en servidor con **Zod**.
- **Consultas parametrizadas**; los campos de ordenamiento se resuelven contra una lista blanca.
- Cabeceras de seguridad (CSP, HSTS, `nosniff`, `frame-ancestors 'none'`) y **CORS** limitado.
- **Rate limiting** general y reforzado en el inicio de sesión.
- Cargas: validación de extensión, tamaño y **firma binaria real**; rechazo de macros y
  vínculos externos; nombre de archivo generado por el servidor; neutralización de fórmulas CSV.
- **Secretos solo en variables de entorno**; `.env.example` no contiene valores reales.
- **Logs estructurados con redacción** de contraseñas, tokens y cookies.
- **Auditoría** de toda acción relevante con datos antes/después, motivo, IP y correlación.

---

## Documentación

| Documento | Contenido |
|---|---|
| [Arquitectura](docs/arquitectura.md) | Diagrama, capas, flujos y decisiones de diseño |
| [Modelo de datos](docs/modelo-datos.md) | Entidad-relación, tablas, índices y unicidad |
| [Matriz de permisos](docs/matriz-permisos.md) | RBAC completo por rol y permiso |
| [Manual de usuario](docs/manual-usuario.md) | Guía por rol, paso a paso |
| [Despliegue](docs/despliegue.md) | VPS, HTTPS, Docker o systemd, actualización |
| [Operación](docs/operacion.md) | Respaldo, restauración, monitoreo e incidentes |
| [Supuestos y limitaciones](docs/supuestos-limitaciones.md) | Alcance real y pasos para activar Huawei |
| [OpenAPI](docs/openapi.json) | 60 rutas y 75 operaciones documentadas |

La especificación también se sirve en línea: `GET /api/openapi.json`.

---

## Alcance excluido

Inteligencia artificial o redes neuronales · diseño eléctrico de plantas · instalación o
mantenimiento físico de equipos · modificación de inversores · extracción no autorizada o
*web scraping* de plataformas de fabricantes · portal público para clientes finales.
