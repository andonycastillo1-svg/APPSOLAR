-- =====================================================================
-- 009_modalidad_eds.sql
--
-- La pantalla de proyectos y el API ofrecen la modalidad comercial EDS
-- (junto a PPA y EPC), pero la columna `tipo_proyecto` solo aceptaba
-- PPA, EPC, AUTOCONSUMO y OTRO: crear un proyecto EDS fallaba. Se agrega EDS
-- conservando los valores existentes.
-- =====================================================================

ALTER TABLE proyectos
  MODIFY COLUMN tipo_proyecto ENUM('PPA','EPC','EDS','AUTOCONSUMO','OTRO') NOT NULL DEFAULT 'OTRO';
