-- =====================================================================
-- 010_suministradora_y_trimestres_tarifarios.sql
--
-- Cambio de alcance solicitado por Retse, S.A.:
--
--  1. Cada proyecto declara su SUMINISTRADORA de energia:
--       DISTRIBUIDORA     (PPA)  -> tipo de tarifa + valor del kWh que se
--                                   renueva cada trimestre.
--       COMERCIALIZADORA  (EPC)  -> tipo de tarifa + valor PACTADO fijo.
--
--  2. Catalogo de tipos de tarifa (siglas del pliego tarifario).
--
--  3. Los trimestres tarifarios inician en NOVIEMBRE:
--       I   Nov-Dic-Ene    II  Feb-Mar-Abr
--       III May-Jun-Jul    IV  Ago-Sep-Oct
--     `tarifas_kwh.anio` pasa a ser el ANIO TARIFARIO: el anio calendario en
--     que inicia el noviembre del periodo (anio 2025 = nov-2025 a oct-2026).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Catalogo de tipos de tarifa
-- ---------------------------------------------------------------------
CREATE TABLE tipos_tarifa (
  id_tipo_tarifa INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sigla          VARCHAR(10)  NOT NULL,
  nombre         VARCHAR(160) NOT NULL,
  activo         TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_tipo_tarifa),
  UNIQUE KEY uk_tipo_tarifa_sigla (sigla)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO tipos_tarifa (sigla, nombre) VALUES
  ('TS',   'Social'),
  ('BTSA', 'Baja Tension Autoproductores'),
  ('AP',   'Alumbrado publico'),
  ('APPN', 'Alumbrado Privado o Publicitario Nocturno'),
  ('VSC',  'Vigilancia, Seguridad o Comunicaciones'),
  ('BTDA', 'Baja Tension con Demanda Autoproductores'),
  ('MTDA', 'Media Tension con Demanda Autoproductores'),
  ('BTHD', 'Baja Tension Horaria con Demanda'),
  ('BTSH', 'Baja Tension Simple Horaria'),
  ('MTHD', 'Media Tension Horaria con Demanda'),
  ('PBT',  'Peaje en Funcion de Transportista Baja Tension'),
  ('PMT',  'Peaje en Funcion de Transportista Media Tension');


-- ---------------------------------------------------------------------
-- 2. Suministradora en el proyecto
-- ---------------------------------------------------------------------
ALTER TABLE proyectos
  ADD COLUMN suministradora ENUM('DISTRIBUIDORA','COMERCIALIZADORA') NULL AFTER tipo_proyecto,
  ADD COLUMN id_tipo_tarifa INT UNSIGNED NULL AFTER suministradora,
  ADD COLUMN valor_pactado_kwh DECIMAL(12,6) NULL
    COMMENT 'Solo COMERCIALIZADORA: valor del kWh pactado, fijo, sin renovacion trimestral'
    AFTER id_tipo_tarifa,
  ADD KEY ix_proyectos_tipo_tarifa (id_tipo_tarifa),
  ADD CONSTRAINT fk_proyectos_tipo_tarifa FOREIGN KEY (id_tipo_tarifa) REFERENCES tipos_tarifa(id_tipo_tarifa),
  ADD CONSTRAINT ck_proyectos_valor_pactado CHECK (valor_pactado_kwh IS NULL OR valor_pactado_kwh >= 0);

-- Los PPA quedan con distribuidora y los EPC con comercializadora; el tipo de
-- tarifa y el valor pactado se completan desde la ficha del proyecto.
UPDATE proyectos
   SET suministradora = CASE tipo_proyecto
         WHEN 'PPA' THEN 'DISTRIBUIDORA'
         WHEN 'EPC' THEN 'COMERCIALIZADORA'
         ELSE NULL
       END;


-- ---------------------------------------------------------------------
-- 3. Tarifas: nuevo origen y re-etiquetado a trimestres tarifarios
-- ---------------------------------------------------------------------
ALTER TABLE tarifas_kwh
  MODIFY COLUMN origen ENUM('MANUAL','COPIA_MES_ANTERIOR','IMPORTACION','PACTADA')
    NOT NULL DEFAULT 'MANUAL';

-- Cada tarifa existente cubria un trimestre calendario; se conserva el
-- criterio de la migracion 006 (el ULTIMO mes del periodo) para ubicarla en
-- el nuevo trimestre:  Ene-Mar -> II,  Abr-Jun -> III,  Jul-Sep -> IV,
-- Oct-Dic -> I (del mismo anio tarifario).
ALTER TABLE tarifas_kwh DROP INDEX uk_tarifa_vigente;

UPDATE tarifas_kwh
   SET trimestre = IF(trimestre = 4, 1, trimestre + 1);

ALTER TABLE tarifas_kwh
  ADD UNIQUE KEY uk_tarifa_vigente (clave_vigente);


-- ---------------------------------------------------------------------
-- 4. Revalorizacion con los nuevos trimestres
-- ---------------------------------------------------------------------
UPDATE produccion
   SET id_tarifa = NULL,
       costo_kwh_aplicado = NULL,
       valor_q = NULL,
       estado_valorizacion = 'PENDIENTE_DE_TARIFA'
 WHERE activo = 1;

UPDATE produccion p
  JOIN tarifas_kwh t
    ON  t.id_proyecto = p.id_proyecto
    AND t.anio        = IF(p.mes >= 11, p.anio, p.anio - 1)
    AND t.trimestre   = FLOOR((p.mes + 1) % 12 / 3) + 1
    AND t.estado      = 'APROBADA'
   SET p.id_tarifa           = t.id_tarifa,
       p.costo_kwh_aplicado  = t.costo_kwh,
       p.valor_q             = ROUND(p.kwh * t.costo_kwh, 4),
       p.estado_valorizacion = 'VALORIZADA'
 WHERE p.activo = 1;
