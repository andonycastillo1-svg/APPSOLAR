-- =====================================================================
-- 013_reporte_inventario.sql
--
-- Nuevo tipo de reporte INVENTARIO: stock de proyectos con su cliente,
-- grupos, inversores, paneles, potencia, produccion y valor, con fila de
-- total para gerencia.
-- =====================================================================

ALTER TABLE reportes
  MODIFY COLUMN tipo
    ENUM('PRODUCCION','RESUMEN_ANUAL','COMPARATIVO','VALORIZACION','INVENTARIO') NOT NULL;
