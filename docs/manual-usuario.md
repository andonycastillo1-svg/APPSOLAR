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
Menú **Analisis → Tablero**. Elija cliente, proyecto, inversor y rango de fechas.

Verá: producción del periodo, valor económico, proyección y **% de cumplimiento**,
variación contra el periodo anterior equivalente, producción de hoy/mes/año, catálogos
activos y equivalencias ambientales.

> ⚠️ Si aparece **“Valorización parcial”**, hay meses sin tarifa aprobada. La energía es
> correcta, pero el monto en quetzales está incompleto: no lo use como cifra oficial.

### Resumen anual (equivalente al Excel de referencia)
Menú **Analisis → Resumen anual**. Seleccione año, cliente y planta.

La tabla muestra las 12 filas de enero a diciembre con: proyección kWh, generación del año
anterior, % de cumplimiento del año anterior, generación del año seleccionado, % de
cumplimiento, tarifa Q/kWh y valor producido; más la fila de totales anuales y la gráfica
comparativa.

> La columna **Tarifa Q/kWh** solo se muestra al elegir un proyecto concreto, porque cada
> proyecto tiene su propia tarifa mensual.

### Reportes
Menú **Analisis → Reportes**.

1. Elija tipo, periodo, cliente, proyecto y, si desea, inversores específicos.
2. Pulse **Generar reporte**. Queda guardado en el historial.
3. Exporte a **PDF**, **XLSX** o **CSV**, o use **Vista de impresión**.

> ⚠️ Si el reporte indica que **no puede considerarse un documento oficial completo**, hay
> meses sin tarifa aprobada. Solicite al coordinador que las registre antes de distribuirlo.

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
Menú **Operacion → Produccion**. Filtre por periodo, cliente, proyecto e inversor.
Puede registrar producción manual y exportar la consulta.

En la tabla, la columna **Valor** muestra “Pendiente de tarifa” cuando el mes aún no tiene
tarifa aprobada. La energía es válida; solo falta la valorización.

---

## 4. Manual del **coordinador de tarifas**

Un usuario operativo con el permiso `tarifas.gestionar`.

Menú **Catalogos → Proyectos → (elegir proyecto) → Tarifas de energia**.

1. Seleccione el año. Verá el calendario de los 12 meses con su tarifa, estado, autor,
   producción asociada y si el periodo está cerrado.
2. En un mes sin tarifa pulse **Registrar** e ingrese el costo del kWh en GTQ
   (se almacena con 6 decimales).
3. También puede **Copiar mes anterior**: el sistema pide confirmación explícita y crea
   un **BORRADOR**; nunca aplica la copia en silencio.
4. Un administrador debe **Aprobar** la tarifa para que tenga efecto. Al aprobarla, el
   sistema valoriza automáticamente los registros de ese mes que estaban pendientes.

> Los meses marcados en rojo tienen producción registrada **sin tarifa aprobada**:
> son los que requieren atención inmediata.

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
  que muestra registros afectados, kWh, valor anterior y valor nuevo. Después debe indicar
  un motivo (mínimo 10 caracteres) y confirmar. Todo queda auditado antes/después.
- **Anular**: los kWh se conservan intactos y los registros vuelven a *pendiente de tarifa*.

### Cierre mensual
- **Cerrar mes**: solo se permite si no quedan registros sin tarifa aprobada. Un mes
  cerrado no admite cambios de tarifa ni de producción.
- **Reabrir mes**: requiere motivo y queda registrado en la auditoría.

### Proyecciones
En **Proyecciones mensuales** de cada proyecto: capture el calendario anual, copie las
proyecciones de otro año con un factor de ajuste, y apruébelas. El **año siempre se elige
de forma explícita**: el sistema nunca lo deduce.

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

## 6. Accesibilidad

- Toda la aplicación se maneja con teclado; el foco es siempre visible.
- Enlace **“Saltar al contenido principal”** al inicio de cada página.
- Los campos tienen etiqueta asociada y los mensajes de error se vinculan al campo.
- Las tablas tienen encabezados de fila y columna, y anuncian el orden aplicado.
- Las gráficas ofrecen su alternativa en tabla.
- Las ventanas emergentes atrapan el foco y se cierran con `Escape`.

---

## 7. Preguntas frecuentes

**¿Por qué mi reporte dice “monto parcial”?**
Porque hay meses del periodo sin tarifa aprobada. Regístrelas y el monto se completará.

**Cargué el mismo archivo dos veces, ¿se duplicó la energía?**
No. La segunda carga detecta los duplicados y, según la política elegida, actualiza u omite.

**Aparecen dos niveles de detalle en un mes. ¿Se suma todo?**
No. Cuando existe detalle por inversor, el consolidado de ese mes se ignora en los totales
para no contar la energía dos veces. El sistema se lo indica explícitamente.

**¿Puedo editar el valor en quetzales?**
No. El valor siempre se deriva de `kWh × tarifa del mes`. Corrija los kWh o la tarifa.
