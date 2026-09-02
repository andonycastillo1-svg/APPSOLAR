-- =====================================================================
-- 006_grupos_y_tarifa_trimestral.sql
--
-- Cuatro cambios de alcance solicitados por Retse, S.A.:
--
--  1. Jerarquia PROYECTO -> GRUPO -> INVERSOR.
--     Un proyecto tiene varios grupos; un grupo tiene varios inversores.
--     El grupo declara su cantidad de inversores y si cuenta con banco de
--     baterias (indicador y capacidad declarada, de caracter informativo).
--
--  2. Produccion consolidada A NIVEL DE GRUPO, para poder cargar
--     manualmente los rangos de fechas que Huawei no entrego por fallas de
--     conexion del grupo, sin perder ni duplicar informacion.
--
--  3. La tarifa del kWh pasa de MENSUAL a TRIMESTRAL (trimestres
--     calendario: Ene-Mar, Abr-Jun, Jul-Sep, Oct-Dic).
--
--  4. La proyeccion anual sigue siendo MENSUAL (no cambia): se captura al
--     crear el proyecto y es la base de las comparativas de cumplimiento.
--
-- POLITICA DE CONSOLIDACION TARIFARIA (decidida con el cliente):
--   Por cada proyecto/anio/trimestre se conserva la tarifa del ULTIMO MES
--   APROBADO del trimestre. Las demas quedan ANULADAS con su motivo, de modo
--   que el historial y la auditoria se preservan intactos. Toda la produccion
--   se revaloriza con la tarifa trimestral resultante.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Grupos de inversores
-- ---------------------------------------------------------------------
CREATE TABLE grupos (
  id_grupo        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_proyecto     INT UNSIGNED NOT NULL,
  nombre          VARCHAR(120) NOT NULL,
  -- Cantidad declarada por el operador. Se compara contra los inversores
  -- realmente registrados para detectar equipos faltantes.
  cantidad_inversores_declarada SMALLINT UNSIGNED NULL,
  tiene_banco_baterias   TINYINT(1) NOT NULL DEFAULT 0,
  capacidad_baterias_kwh DECIMAL(14,3) NULL COMMENT 'Capacidad declarada del banco en kWh',
  capacidad_kwp   DECIMAL(14,3) NULL COMMENT 'Potencia instalada del grupo en kWp',
  ubicacion       VARCHAR(255) NULL,
  observaciones   VARCHAR(500) NULL,
  activo          TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT UNSIGNED NULL,
  updated_by      INT UNSIGNED NULL,
  PRIMARY KEY (id_grupo),
  UNIQUE KEY uk_grupo_nombre (id_proyecto, nombre),
  KEY ix_grupos_proyecto (id_proyecto),
  KEY ix_grupos_activo (activo),
  CONSTRAINT fk_grupos_proyecto FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto),
  CONSTRAINT ck_grupos_capacidad CHECK (capacidad_kwp IS NULL OR capacidad_kwp >= 0),
  CONSTRAINT ck_grupos_baterias CHECK (
    capacidad_baterias_kwh IS NULL OR capacidad_baterias_kwh >= 0
  ),
  -- Coherencia: no se declara capacidad de baterias en un grupo que no las tiene.
  CONSTRAINT ck_grupos_banco CHECK (
    tiene_banco_baterias = 1 OR capacidad_baterias_kwh IS NULL
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 2. Todo proyecto existente recibe un grupo inicial y sus inversores
--    quedan asignados a el. A partir de esta migracion el grupo es
--    obligatorio para cualquier inversor.
-- ---------------------------------------------------------------------
INSERT INTO grupos (id_proyecto, nombre, capacidad_kwp, observaciones, activo)
SELECT p.id_proyecto,
       'Grupo principal',
       p.capacidad_kwp,
       'Grupo creado automaticamente por la migracion 006 para agrupar los inversores existentes.',
       1
  FROM proyectos p;

ALTER TABLE inversores
  ADD COLUMN id_grupo INT UNSIGNED NULL AFTER id_proyecto;

UPDATE inversores i
  JOIN grupos g ON g.id_proyecto = i.id_proyecto AND g.nombre = 'Grupo principal'
   SET i.id_grupo = g.id_grupo;

ALTER TABLE inversores
  MODIFY COLUMN id_grupo INT UNSIGNED NOT NULL,
  ADD KEY ix_inversores_grupo (id_grupo),
  ADD CONSTRAINT fk_inversores_grupo FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo);


-- ---------------------------------------------------------------------
-- 3. Produccion: tercer nivel de detalle (grupo)
--
--    Jerarquia de precedencia para evitar el doble conteo:
--      POR_INVERSOR  >  GRUPO_CONSOLIDADO  >  PROYECTO_CONSOLIDADO
--
--    La resolucion se hace POR GRUPO, no por proyecto: si el grupo A tiene
--    detalle por inversor y el grupo B solo tiene su consolidado (porque
--    perdio la conexion), ambos se suman correctamente sin descartar B.
-- ---------------------------------------------------------------------
ALTER TABLE produccion
  ADD COLUMN id_grupo INT UNSIGNED NULL AFTER id_inversor,
  MODIFY COLUMN nivel_detalle
    ENUM('POR_INVERSOR','GRUPO_CONSOLIDADO','PROYECTO_CONSOLIDADO') NOT NULL;

UPDATE produccion p
  JOIN inversores i ON i.id_inversor = p.id_inversor
   SET p.id_grupo = i.id_grupo
 WHERE p.id_inversor IS NOT NULL;

-- La clave de unicidad debe distinguir el grupo: dos consolidados de grupos
-- distintos comparten fecha y tienen id_inversor NULL.
ALTER TABLE produccion
  DROP INDEX uk_produccion,
  ADD COLUMN grupo_key INT UNSIGNED GENERATED ALWAYS AS (COALESCE(id_grupo, 0)) STORED,
  ADD UNIQUE KEY uk_produccion
      (id_proyecto, grupo_key, inversor_key, fecha, granularidad, origen, secuencia),
  ADD KEY ix_prod_grupo_periodo (id_grupo, anio, mes),
  -- La FK va sin CASCADE: id_grupo es columna base de una columna generada
  -- STORED y MySQL no admite acciones referenciales en ese caso.
  ADD CONSTRAINT fk_prod_grupo FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo);

ALTER TABLE produccion
  DROP CHECK ck_prod_nivel,
  ADD CONSTRAINT ck_prod_nivel CHECK (
    (nivel_detalle = 'POR_INVERSOR'         AND id_inversor IS NOT NULL AND id_grupo IS NOT NULL) OR
    (nivel_detalle = 'GRUPO_CONSOLIDADO'    AND id_inversor IS NULL     AND id_grupo IS NOT NULL) OR
    (nivel_detalle = 'PROYECTO_CONSOLIDADO' AND id_inversor IS NULL     AND id_grupo IS NULL)
  );

-- Los lotes de importacion tambien pueden apuntar a un grupo.
ALTER TABLE historicos
  ADD COLUMN id_grupo INT UNSIGNED NULL AFTER id_proyecto,
  MODIFY COLUMN nivel_detalle
    ENUM('POR_INVERSOR','GRUPO_CONSOLIDADO','PROYECTO_CONSOLIDADO') NOT NULL,
  ADD KEY ix_hist_grupo (id_grupo),
  ADD CONSTRAINT fk_hist_grupo FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo) ON DELETE SET NULL;

-- Las sincronizaciones pueden acotarse a un grupo.
ALTER TABLE sincronizaciones
  ADD COLUMN id_grupo INT UNSIGNED NULL AFTER id_proyecto,
  ADD KEY ix_sync_grupo (id_grupo),
  ADD CONSTRAINT fk_sync_grupo FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo) ON DELETE SET NULL;


-- ---------------------------------------------------------------------
-- 4. Tarifa del kWh: de mensual a trimestral
-- ---------------------------------------------------------------------

ALTER TABLE tarifas_kwh
  ADD COLUMN trimestre TINYINT UNSIGNED NULL AFTER anio;

UPDATE tarifas_kwh SET trimestre = CEIL(mes / 3);

-- Se libera la unicidad mensual antes de consolidar.
ALTER TABLE tarifas_kwh
  DROP INDEX uk_tarifa_vigente,
  DROP COLUMN clave_vigente;

-- Se conserva una sola tarifa vigente por trimestre: la del ultimo mes
-- APROBADO; si el trimestre no tuviera ninguna aprobada, la del ultimo mes
-- en borrador. Las demas se anulan dejando constancia del motivo.
UPDATE tarifas_kwh t
  JOIN (
    SELECT id_proyecto,
           anio,
           trimestre,
           CAST(
             SUBSTRING_INDEX(
               GROUP_CONCAT(id_tarifa ORDER BY (estado = 'APROBADA') DESC, mes DESC),
               ',', 1
             ) AS UNSIGNED
           ) AS id_conservar
      FROM tarifas_kwh
     WHERE estado <> 'ANULADA'
     GROUP BY id_proyecto, anio, trimestre
  ) sobreviviente
    ON  sobreviviente.id_proyecto = t.id_proyecto
    AND sobreviviente.anio        = t.anio
    AND sobreviviente.trimestre   = t.trimestre
   SET t.estado          = 'ANULADA',
       t.fecha_anulacion = NOW(),
       t.motivo = CONCAT(
         'Consolidacion trimestral automatica (migracion 006). ',
         'La tarifa paso de vigencia mensual a trimestral y se conservo la del ',
         'ultimo mes aprobado del trimestre ', t.trimestre, '/', t.anio, '.'
       )
 WHERE t.estado <> 'ANULADA'
   AND t.id_tarifa <> sobreviviente.id_conservar;

ALTER TABLE tarifas_kwh
  MODIFY COLUMN trimestre TINYINT UNSIGNED NOT NULL,
  MODIFY COLUMN mes TINYINT UNSIGNED NULL
    COMMENT 'Solo historico: mes de origen antes de la consolidacion trimestral',
  ADD COLUMN clave_vigente VARCHAR(40) GENERATED ALWAYS AS
      (IF(estado = 'ANULADA', NULL, CONCAT(id_proyecto, '-', anio, '-T', trimestre))) STORED,
  ADD UNIQUE KEY uk_tarifa_vigente (clave_vigente),
  ADD KEY ix_tarifas_trimestre (id_proyecto, anio, trimestre, estado),
  ADD CONSTRAINT ck_tarifas_trimestre CHECK (trimestre BETWEEN 1 AND 4);


-- ---------------------------------------------------------------------
-- 5. Revalorizacion completa de la produccion con la tarifa trimestral
-- ---------------------------------------------------------------------

-- 5.1 Todo vuelve a pendiente: se descarta cualquier vinculo con las
--     tarifas mensuales anuladas por la consolidacion.
UPDATE produccion
   SET id_tarifa = NULL,
       costo_kwh_aplicado = NULL,
       valor_q = NULL,
       estado_valorizacion = 'PENDIENTE_DE_TARIFA'
 WHERE activo = 1;

-- 5.2 Se aplica la tarifa trimestral aprobada que corresponde al mes de
--     cada registro. Los meses sin tarifa aprobada quedan pendientes, tal
--     como exige la regla de negocio.
UPDATE produccion p
  JOIN tarifas_kwh t
    ON  t.id_proyecto = p.id_proyecto
    AND t.anio        = p.anio
    AND t.trimestre   = CEIL(p.mes / 3)
    AND t.estado      = 'APROBADA'
   SET p.id_tarifa           = t.id_tarifa,
       p.costo_kwh_aplicado  = t.costo_kwh,
       p.valor_q             = ROUND(p.kwh * t.costo_kwh, 4),
       p.estado_valorizacion = 'VALORIZADA'
 WHERE p.activo = 1;


-- ---------------------------------------------------------------------
-- 6. Cierres mensuales: se conservan como estan.
--    El cierre sigue siendo por mes porque la produccion y la proyeccion
--    son mensuales; solo la tarifa cambia de periodicidad.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 7. Parametros nuevos de configuracion
-- ---------------------------------------------------------------------
INSERT INTO configuracion (clave, valor, tipo, categoria, descripcion, unidad, fuente, editable) VALUES
  ('tarifa.periodicidad', 'TRIMESTRAL', 'TEXTO', 'REPORTES',
   'Periodicidad de la tarifa del kWh. Fijada por politica de la organizacion.',
   NULL, NULL, 0),
  ('tarifa.dias_aviso_trimestre', '15', 'NUMERO', 'REPORTES',
   'Dias de anticipacion con que se avisa que el proximo trimestre necesita tarifa',
   'dias', NULL, 1),
  ('proyecto.exigir_proyeccion', 'true', 'BOOLEANO', 'GENERAL',
   'Exige capturar los 12 meses de proyeccion al crear un proyecto',
   NULL, NULL, 1),
  ('grupo.avisar_inversores_faltantes', 'true', 'BOOLEANO', 'GENERAL',
   'Avisa cuando un grupo tiene menos inversores registrados que los declarados',
   NULL, NULL, 1);
