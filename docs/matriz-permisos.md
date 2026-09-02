# Matriz de roles y permisos

El control de acceso es **RBAC con permisos individuales**. Se aplica siempre en el
servidor: ocultar una opción en la interfaz nunca sustituye la autorización del backend.

- Fuente de verdad en código: `backend/src/config/permisos.ts`
- Fuente de verdad en base de datos: `database/migrations/005_catalogos.sql`
- La prueba `backend/tests/rbac.test.ts` **verifica que ambas coincidan** y comprueba
  el acceso permitido y denegado de cada rol endpoint por endpoint.

---

## 1. Roles

| Rol | Descripción |
|---|---|
| **ADMINISTRATIVO** | Gestiona usuarios, catálogos, integración, tarifas y auditoría. Tiene todos los permisos. |
| **OPERATIVO** | Operación diaria: inversores, carga de históricos, sincronización y consulta. |
| **GERENCIAL** | Estrictamente de solo lectura sobre información consolidada, con reportes. |

**El coordinador de tarifas no es un cuarto rol.** Es un usuario OPERATIVO al que un
administrador le otorga individualmente el permiso `tarifas.gestionar`.

---

## 2. Matriz completa

Leyenda: **✔** incluido en el rol · **✖** no incluido · **◐** se otorga individualmente.

| Permiso | Descripción | ADMIN | OPER | GEREN |
|---|---|:---:|:---:|:---:|
| `usuarios.ver` | Consultar usuarios y sus permisos | ✔ | ✖ | ✖ |
| `usuarios.gestionar` | Crear, editar, activar/desactivar y restablecer | ✔ | ✖ | ✖ |
| `clientes.ver` | Consultar clientes | ✔ | ✔ | ✔ |
| `clientes.gestionar` | Crear, editar y desactivar clientes | ✔ | ✖ | ✖ |
| `proyectos.ver` | Consultar proyectos solares | ✔ | ✔ | ✔ |
| `proyectos.gestionar` | Crear, editar y desactivar proyectos | ✔ | ✖ | ✖ |
| `inversores.ver` | Consultar inversores | ✔ | ✔ | ✔ |
| `inversores.gestionar` | Crear, editar y desactivar inversores **y sus grupos** | ✔ | ✔ | ✖ |
| `produccion.ver` | Consultar producción energética | ✔ | ✔ | ✔ |
| `produccion.registrar` | Registrar producción manualmente | ✔ | ✔ | ✖ |
| `produccion.corregir` | Corregir registros con motivo y auditoría | ✔ | ✖ | ✖ |
| `importaciones.ver` | Consultar el historial de importaciones | ✔ | ✔ | ✔ |
| `importaciones.cargar` | Cargar, previsualizar y confirmar archivos | ✔ | ✔ | ✖ |
| `tarifas.ver` | Consultar tarifas **trimestrales** y su aviso de actualización | ✔ | ✔ | ✔ |
| `tarifas.gestionar` | Registrar y editar tarifas trimestrales en BORRADOR | ✔ | ◐ | ✖ |
| `tarifas.aprobar` | Aprobar o anular tarifas | ✔ | ✖ | ✖ |
| `tarifas.recalcular` | Corregir tarifas usadas y recalcular | ✔ | ✖ | ✖ |
| `tarifas.cerrar_mes` | Cerrar un periodo mensual | ✔ | ✖ | ✖ |
| `tarifas.reabrir_mes` | Reabrir un periodo cerrado | ✔ | ✖ | ✖ |
| `proyecciones.ver` | Consultar proyecciones mensuales | ✔ | ✔ | ✔ |
| `proyecciones.gestionar` | Registrar, importar y copiar proyecciones | ✔ | ◐ | ✖ |
| `proyecciones.aprobar` | Aprobar o anular proyecciones | ✔ | ✖ | ✖ |
| `huawei.ver` | Consultar configuración y ejecuciones | ✔ | ✔ | ✖ |
| `huawei.configurar` | Configurar la integración | ✔ | ✖ | ✖ |
| `huawei.sincronizar` | Probar conexión y sincronizar | ✔ | ✔ | ✖ |
| `dashboard.ver` | Consultar el tablero | ✔ | ✔ | ✔ |
| `reportes.ver` | Consultar reportes generados | ✔ | ✔ | ✔ |
| `reportes.generar` | Generar reportes | ✔ | ✔ | ✔ |
| `reportes.exportar` | Exportar e imprimir (PDF/CSV/XLSX) | ✔ | ✔ | ✔ |
| `auditoria.ver` | Consultar la bitácora de auditoría | ✔ | ✖ | ✖ |
| `config.ver` | Consultar parámetros del sistema | ✔ | ✖ | ✖ |
| `config.gestionar` | Modificar parámetros | ✔ | ✖ | ✖ |
| `salud.ver` | Estado detallado de los servicios | ✔ | ✖ | ✖ |

**Total: 33 permisos.**

---

## 3. Reglas de autorización adicionales

| Regla | Comportamiento |
|---|---|
| Todo endpoint protegido | Incluye el caso de uso transversal “Autenticar usuario” |
| Rol gerencial | **Nunca** puede recibir permisos de escritura, ni siquiera de forma individual |
| Último administrador activo | No puede desactivarse ni cambiar de rol |
| Usuario propio | No puede desactivarse a sí mismo |
| Desactivación o cambio de rol | Revoca de inmediato las sesiones activas del usuario |
| Aprobar una tarifa al crearla | Exige además `tarifas.aprobar`; el coordinador solo crea borradores |
| Corregir una tarifa ya usada | Exige `tarifas.recalcular`, análisis de impacto, motivo y confirmación |
| Reabrir un periodo cerrado | Exige `tarifas.reabrir_mes` y un motivo de al menos 10 caracteres |

---

## 4. Permisos efectivos

```
permisos efectivos = permisos del rol
                   + permisos otorgados individualmente (usuario_permisos.otorgado = 1)
                   − permisos revocados individualmente (usuario_permisos.otorgado = 0)
```

Se resuelven en el servidor en cada petición (`services/auth.ts → permisosEfectivos`) y se
devuelven al frontend en `/api/auth/me` únicamente para adaptar la interfaz.

---

## 5. Cómo habilitar a un coordinador de tarifas

1. Ingresar como usuario administrativo.
2. **Usuarios y permisos → Permisos** en la fila del usuario operativo.
3. Marcar `tarifas.gestionar` y guardar.
4. El cambio queda registrado en la auditoría (`PERMISOS_ACTUALIZADOS`) y el usuario
   verá el módulo de tarifas en su siguiente petición.

El coordinador podrá **registrar y editar** tarifas en BORRADOR, pero la **aprobación**
seguirá siendo responsabilidad de un usuario administrativo.
