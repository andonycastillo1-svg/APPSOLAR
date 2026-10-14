-- =====================================================================
-- 012_permisos_operativo_ampliados.sql
--
-- El rol OPERATIVO pasa a gestionar toda la informacion del negocio:
-- clientes, proyectos (con su proyeccion), grupos, inversores, carga manual
-- y correccion de produccion, y todo lo referente a tarifas. Queda fuera de
-- su alcance la administracion del sistema: usuarios y permisos, auditoria,
-- configuracion, respaldos y credenciales de la integracion Huawei.
-- =====================================================================

INSERT INTO rol_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
  FROM roles r
  JOIN permisos p ON p.codigo IN (
         'clientes.gestionar',
         'proyectos.gestionar',
         'produccion.corregir',
         'proyecciones.gestionar',
         'proyecciones.aprobar',
         'tarifas.gestionar',
         'tarifas.aprobar',
         'tarifas.recalcular',
         'tarifas.cerrar_mes',
         'tarifas.reabrir_mes')
 WHERE r.codigo = 'OPERATIVO'
   AND NOT EXISTS (
         SELECT 1 FROM rol_permisos x
          WHERE x.id_rol = r.id_rol AND x.id_permiso = p.id_permiso);
