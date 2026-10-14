-- =====================================================================
-- 008_permiso_sincronizar_ahora.sql
--
-- Boton "Sincronizar ahora" del menu principal: trae la produccion de
-- Huawei hasta este momento sin pedir fechas. Se concede a los tres roles
-- (administrativo, operativo y gerencial) porque la accion solo refresca
-- datos del fabricante y es idempotente: repetirla no suma de nuevo.
-- =====================================================================

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('produccion.sincronizar_ahora', 'Integracion',
   'Sincronizar con Huawei, desde el menu principal, toda la produccion hasta este momento');

INSERT INTO rol_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
  FROM roles r JOIN permisos p ON p.codigo = 'produccion.sincronizar_ahora'
 WHERE r.codigo IN ('ADMINISTRATIVO', 'OPERATIVO', 'GERENCIAL');
