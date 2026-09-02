# Manual de usuario

Sistema Centralizado de Monitoreo Energético · Retse, S.A.

---

## Convenciones de toda la aplicación

| Concepto | Formato |
|---|---|
| Energía generada | **kWh** (nunca kWp) |
| Potencia instalada | **kWp** (solo para equipos y plantas) |
| Moneda | Quetzal guatemalteco, **Q** (código GTQ) |
| Fechas visibles | **dd/mm/aaaa** |
| Zona horaria | America/Guatemala |

**Estados que verá con frecuencia**

| Etiqueta | Significado |
|---|---|
| 🟢 **Aprobada / Valorizada / Completado** | El dato es definitivo y utilizable en reportes oficiales |
| 🟡 **Borrador / Pendiente de tarifa** | El dato existe pero aún no puede usarse como oficial |
| 🔴 **Anulada / Fallido / Rechazado** | El dato quedó fuera de uso; se conserva por trazabilidad |
| 🔵 **Simulado** | Proviene del modo sandbox de la integración: **no** es dato real del fabricante |

---

## 1. Ingreso y perfil (todos los roles)

1. Abra el subdominio institucional e ingrese con su correo y contraseña.
2. Si un administrador le asignó la contraseña, el sistema le pedirá cambiarla en
   **Mi perfil → Cambiar contraseña** antes de continuar.
3. La contraseña debe tener al menos 10 caracteres con mayúscula, minúscula, número y
   un carácter especial. Al cambiarla se cierran sus demás sesiones.
4. Tras 5 intentos fallidos su usuario se bloquea temporalmente 15 minutos.
5. En **Mi perfil** puede ver sus permisos efectivos y su último acceso.

> ¿Olvidó su contraseña? Solicite el restablecimiento a un usuario administrativo.
> El sistema **nunca** muestra ni recupera contraseñas existentes.

---

## 2. Manual del usuario **gerencial** (solo lectura)

### Tablero
Menú **Analisis → Tablero**. Elija cliente, proyecto, **grupo**, inversor y rango de fechas.

Verá: producción del periodo, valor económico, proyección y **% de cumplimiento**,
variación contra el periodo anterior equivalente, producción de hoy/mes/año, **generación
por grupo de inversores**, catálogos activos y equivalencias ambientales.

> ⚠️ Si aparece **“Valorización parcial”**, hay trimestres sin tarifa aprobada. La energía es
> correcta, pero el monto en quetzales está incompleto: no lo use como cifra oficial.

> 🟠 Si aparece **“Actualización trimestral de la tarifa pendiente”**, el trimestre en curso
> (o el siguiente, si ya está por comenzar) no tiene tarifa aprobada. El aviso enlaza
> directamente con los proyectos afectados.

### Resumen anual (equivalente al Excel de referencia)
Menú **Analisis → Resumen anual**. Seleccione año, cliente y planta.

La tabla muestra las 12 filas de enero a diciembre con: **trimestre**, proyección kWh,
generación del año anterior, % de cumplimiento del año anterior, generación del año
seleccionado, % de cumplimiento, tarifa Q/kWh y valor producido; más la fila de totales
anuales y la gráfica comparativa.

> La columna **Tarifa Q/kWh** solo se muestra al elegir un proyecto concreto, porque cada
> proyecto tiene su propia tarifa. Los tres meses de un mismo trimestre muestran **la misma
> tarifa**: el costo del kWh se pacta por trimestre.

> La proyección con la que se compara es la que se capturó **al crear el proyecto**. Es el
> compromiso pactado desde el inicio, y por eso es la base del % de cumplimiento.

### Reportes
Menú **Analisis → Reportes**.

1. Elija tipo, periodo, cliente, proyecto y, si desea, inversores específicos.
2. Pulse **Generar reporte**. Queda guardado en el historial.
3. Exporte a **PDF**, **XLSX** o **CSV**, o use **Vista de impresión**.

> ⚠️ Si el reporte indica que **no puede considerarse un documento oficial completo**, hay
> trimestres sin tarifa aprobada. Solicite al coordinador que las registre antes de
> distribuirlo.

### Gráficas accesibles
Toda gráfica incluye **“Ver los datos de la gráfica en forma de tabla”**: la información
nunca depende únicamente del color.

---

## 3. Manual del usuario **operativo**

### Registrar inversores
Menú **Catalogos → Inversores → Nuevo inversor**.

- El inversor siempre pertenece a un proyecto.
- Si el tipo de conexión es **Huawei SmartPVMS**, el identificador externo (serial) es
  obligatorio: es lo que permite emparejar los datos del fabricante.
- Registre la **potencia instalada (kWp)**: sin ella el equipo no puede incluirse en las
  comparaciones de rendimiento relativo.

### Cargar históricos (asistente de 7 pasos)
Menú **Operacion → Carga de historicos → Nueva importacion**.

1. **Seleccionar destino.** Para el formato histórico puede dejar los campos vacíos: el
   sistema identifica cada planta por su nombre. Para la plantilla normalizada elija el
   proyecto y, si todo el archivo es de un solo equipo, también el inversor.
2. **Descargar plantilla.** Hay plantilla histórica (Planta, Tipo, Año, Mes, Generación,
   Comentarios), plantilla normalizada (fecha, kwh, inversor_serial, comentarios) y un
   archivo de ejemplo con errores para practicar.
3. **Elegir archivo.** CSV o XLSX, máximo 10 MB. No se aceptan libros con macros ni
   vínculos externos.
4. **Validar y previsualizar.** El sistema no modifica ningún dato todavía. Revise filas
   válidas, errores, duplicados, meses sin tarifa y periodos cerrados.
5. **Resolver decisiones.** Si una planta no coincide con ningún proyecto, asígnela.
   Si hay **varias filas de la misma planta y mes sin identificador de inversor**, elija:
   - **SUMAR** — un único registro consolidado con el total.
   - **COMPONENTES** — conservar cada fila como componente del consolidado.
   - **MAPEAR** — asignar cada fila a un inversor (requiere columna `Inversor`/`Serial`).
   - **RECHAZAR** — descartar el grupo para corregir el archivo.
6. **Confirmar la carga.** Elija la política ante duplicados y, si hay filas con error,
   acepte explícitamente la **carga parcial**. Todo se aplica en una sola transacción.
7. **Resumen final.** Vea insertadas, actualizadas, omitidas y rechazadas, y descargue el
   detalle de errores en CSV.

> ⚠️ Si el sistema advierte **riesgo de doble conteo**, ya existe producción de ese mes con
> otro nivel de detalle. Verifique antes de confirmar: mezclar ambos duplicaría la energía.

### Sincronizar con Huawei
Menú **Operacion → Integracion Huawei**.

1. **Probar conexión** antes de la primera sincronización del día.
2. **Sincronizar ahora**: elija el rango (sugerido: últimos 7 días), la granularidad y,
   opcionalmente, el proyecto o inversor.
3. Repetir el mismo rango **no duplica** datos: actualiza los existentes.

> 🔵 Si la etiqueta dice **Simulado (sandbox)**, los datos son ficticios: la integración
> real aún no está activada.

### Consultar y validar producción
Menú **Operacion → Produccion**. Filtre por periodo, cliente, proyecto, **grupo** e inversor.
Puede registrar producción manual y exportar la consulta.

En la tabla, la columna **Valor** muestra “Pendiente de tarifa” cuando el trimestre aún no
tiene tarifa aprobada. La energía es válida; solo falta la valorización.

### Completar datos que el fabricante no entregó

Cuando un **grupo de inversores** pierde la conexión con Huawei, sus días quedan sin
lecturas. El sistema no los inventa: los muestra y le permite completarlos a mano para que
el histórico del proyecto quede íntegro.

1. En **Operacion → Produccion**, elija el periodo y el proyecto. Si hay días sin datos,
   aparece la tarjeta **“Grupos con días sin datos”** con los días esperados, los que sí
   tienen lectura y los que faltan.
2. Pulse **Completar manualmente** en el grupo afectado (o **Cargar rango de un grupo** en
   la barra superior).
3. Indique el **rango de fechas** y cómo debe interpretarse la cifra:
   - **Total del rango** — el sistema la reparte en partes iguales entre los días.
   - **Valor de cada día** — la misma cifra se repite en todos los días del rango.
   El formulario muestra por adelantado cuántos días cubre y cuántos kWh corresponden a
   cada uno.
4. Escriba el **motivo** (mínimo 10 caracteres). Queda en la auditoría y en el comentario
   de cada día cargado.
5. Confirme. El registro se guarda como **consolidado del grupo**, sin inversor asociado.

Puntos importantes:

- **Repetir la misma carga no duplica nada**: los días que ya tenían carga manual se omiten
  y el sistema le informa cuántos fueron. Marque *sobrescribir* solo si desea reemplazarlos
  con cifras corregidas.
- Si el grupo ya tiene un **cierre mensual** de ese mes, el sistema **bloquea** la carga
  diaria: esa cifra mensual ya cubre el mes completo y agregar días sueltos contaría la
  energía dos veces. Corrija el registro mensual, o confirme expresamente la mezcla.
- La carga manual de un grupo **nunca se pierde** aunque otro grupo del mismo proyecto
  reporte por inversor esos mismos días.

---

## 4. Manual del **coordinador de tarifas**

Un usuario operativo con el permiso `tarifas.gestionar`.

Menú **Catalogos → Proyectos → (elegir proyecto) → Tarifas de energia**.

> **La tarifa del kWh se actualiza cada trimestre**, no cada mes. Los tres meses de un
> trimestre comparten siempre el mismo costo por kWh.

1. Seleccione el año. Verá el calendario de los **4 trimestres** (I: enero a marzo,
   II: abril a junio, III: julio a septiembre, IV: octubre a diciembre) con su tarifa,
   estado, autor, producción asociada y qué meses están cerrados.
2. En un trimestre sin tarifa pulse **Registrar** e ingrese el costo del kWh en GTQ
   (se almacena con 6 decimales).
3. También puede **Copiar trimestre anterior**: el sistema pide confirmación explícita y
   crea un **BORRADOR**; nunca aplica la copia en silencio.
4. Un administrador debe **Aprobar** la tarifa para que tenga efecto. Al aprobarla, el
   sistema valoriza automáticamente los registros pendientes de **los tres meses** del
   trimestre.

> Los trimestres marcados en rojo tienen producción registrada **sin tarifa aprobada**:
> son los que requieren atención inmediata.

### Aviso de actualización trimestral

El sistema le recuerda registrar la tarifa a tiempo, en el tablero y en la propia pantalla
de tarifas. El aviso aparece cuando:

- el **trimestre en curso** no tiene tarifa aprobada, o
- faltan pocos días para que termine el trimestre y el **siguiente** aún no la tiene.

El número de días de anticipación es configurable en **Administracion → Configuracion**
(parámetro `tarifa.dias_aviso_trimestre`, por omisión 15 días).

---

## 5. Manual del usuario **administrativo**

### Usuarios y permisos
Menú **Administracion → Usuarios y permisos**.

- **Nuevo usuario**: el sistema genera una contraseña temporal que se muestra **una sola
  vez**. Entréguela por un medio seguro.
- **Permisos**: otorgue `tarifas.gestionar` para habilitar a un coordinador.
- **Restablecer acceso**: genera una nueva contraseña temporal y cierra las sesiones del
  usuario. La contraseña anterior nunca se revela.
- No es posible dejar el sistema sin administradores activos ni desactivarse a sí mismo.

### Aprobar, corregir y anular tarifas
En **Tarifas de energia** de cada proyecto:

- **Aprobar** un borrador.
- **Corregir** una tarifa ya utilizada: el sistema **exige** primero **Analizar impacto**,
  que muestra el trimestre afectado, registros, kWh, valor anterior y valor nuevo. Después
  debe indicar un motivo (mínimo 10 caracteres) y confirmar. Todo queda auditado
  antes/después. Si alguno de los tres meses del trimestre está **cerrado**, primero debe
  reabrirlo.
- **Anular**: los kWh se conservan intactos y los registros vuelven a *pendiente de tarifa*.

### Cierre mensual
El cierre contable sigue siendo **mensual**, aunque la tarifa sea trimestral: al pulsar
**Cerrar mes** elija cuál de los tres meses del trimestre desea cerrar.

- **Cerrar mes**: solo se permite si no quedan registros sin tarifa aprobada. Un mes
  cerrado no admite cambios de tarifa ni de producción.
- **Reabrir mes**: requiere motivo y queda registrado en la auditoría.

### Proyecciones
En **Proyecciones mensuales** de cada proyecto: capture el calendario anual, copie las
proyecciones de otro año con un factor de ajuste, y apruébelas. El **año siempre se elige
de forma explícita**: el sistema nunca lo deduce.

La proyección del primer año **ya se capturó al crear el proyecto** y es obligatoria; aquí
se agregan los años siguientes o se corrigen los existentes.

---

## 6. Crear un proyecto con su árbol y su proyección

Menú **Catalogos → Proyectos → Nuevo proyecto**. El alta es un asistente de **tres pasos** y
no se guarda nada hasta terminarlo: proyecto, proyección y grupos se crean juntos, en una
sola operación.

### Paso 1 · Datos del proyecto
Cliente propietario, nombre de la planta (debe coincidir con la columna *Planta* de los
archivos históricos), modalidad comercial, ubicación, **potencia instalada en kWp** y fecha
de inicio de operación.

### Paso 2 · Proyección anual
**Obligatorio.** Capture los 12 meses en kWh: es el compromiso pactado desde el inicio y la
base contra la que se medirá el cumplimiento real de la planta.

> Atajo: escriba el total anual en el campo *Repartir un total anual en partes iguales* y
> pulse **Repartir en 12 meses**. Después puede ajustar mes por mes según la estacionalidad.
> Puede escribir `0` en los meses sin generación prevista, pero no dejar ninguno vacío.

### Paso 3 · Grupos de inversores
Un proyecto se divide en **grupos** y cada grupo agrupa varios **inversores con sus
seriales**. Para cada grupo indique:

- **Nombre** (por ejemplo, *Bloque A - Campo norte*).
- **Cantidad de inversores** que llevará. El sistema avisa después si faltan por registrar.
- Si **cuenta con banco de baterías** y, en ese caso, su capacidad en kWh.
- Potencia del grupo en kWp y ubicación.

Puede agregar tantos grupos como necesite, o dejar la lista vacía y crearlos más adelante
desde el detalle del proyecto.

> Los **inversores no se capturan aquí**: una vez creado el proyecto, regístrelos desde
> **Catalogos → Inversores** eligiendo su grupo. Todo inversor pertenece a un grupo.

### Administrar los grupos después
Menú **Catalogos → Proyectos → (elegir proyecto) → Grupos de inversores**.

Verá cuántos inversores tiene cada grupo frente a los declarados, si tiene banco de
baterías, su potencia, la producción acumulada y el último dato recibido. Un grupo con
inversores o producción asociada **no se elimina: se desactiva**, para conservar el
histórico.

### Configuración
Menú **Administracion → Configuracion**. Ajuste límites de carga, políticas de sesión,
horario de sincronización y los **factores de equivalencia ambiental**, que declaran su
unidad y su fuente.

### Auditoría
Menú **Administracion → Auditoria**. Filtre por acción, entidad, usuario, resultado y
fechas. **Ver cambios** muestra los datos antes y después.
La auditoría nunca registra contraseñas, tokens ni archivos completos.

### Estado de servicios
Menú **Administracion → Estado de servicios**. Semáforo de API, MySQL, servicio Python e
integración Huawei, más las últimas operaciones de datos. Se actualiza cada 30 segundos.

---

## 7. Accesibilidad

- Toda la aplicación se maneja con teclado; el foco es siempre visible.
- Enlace **“Saltar al contenido principal”** al inicio de cada página.
- Los campos tienen etiqueta asociada y los mensajes de error se vinculan al campo.
- Las tablas tienen encabezados de fila y columna, y anuncian el orden aplicado.
- Las gráficas ofrecen su alternativa en tabla.
- Las ventanas emergentes atrapan el foco y se cierran con `Escape`.

---

## 8. Preguntas frecuentes

**¿Por qué mi reporte dice “monto parcial”?**
Porque hay trimestres del periodo sin tarifa aprobada. Regístrelas y el monto se completará.

**Cargué el mismo archivo dos veces, ¿se duplicó la energía?**
No. La segunda carga detecta los duplicados y, según la política elegida, actualiza u omite.

**Aparecen dos niveles de detalle en un mes. ¿Se suma todo?**
No. Cuando un grupo tiene detalle por inversor en una fecha, su consolidado de esa misma
fecha se ignora en los totales para no contar la energía dos veces. El sistema se lo indica
explícitamente.

**Completé un grupo a mano. ¿Se descarta si los demás grupos sí reportaron?**
No. La resolución de niveles es **por grupo y por fecha**, así que la carga manual de un
grupo incomunicado se suma junto al detalle por inversor de los grupos que sí reportaron.

**¿Puedo editar el valor en quetzales?**
No. El valor siempre se deriva de `kWh × tarifa del trimestre`. Corrija los kWh o la tarifa.

**¿Por qué la tarifa de enero, febrero y marzo es la misma?**
Porque el costo del kWh se pacta **por trimestre calendario**. Los tres meses de un trimestre
comparten la misma tarifa; para cambiarla a mitad de trimestre debe corregirla, lo que
revaloriza los tres meses y queda auditado.
