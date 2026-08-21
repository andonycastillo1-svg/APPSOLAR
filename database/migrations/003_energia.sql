-- =====================================================================
-- 003_energia.sql | Tarifas mensuales, proyecciones, cierres y produccion
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tarifas mensuales de kWh por proyecto (GTQ/kWh)
-- NOTA MySQL: `id_proyecto` es columna base de la columna generada STORED
-- `clave_vigente`, por lo que su clave foranea NO puede usar CASCADE/SET NULL.
-- Se deja en RESTRICT: un proyecto con tarifas no se elimina, se desactiva.
--
-- Regla: a lo sumo UNA tarifa vigente (BORRADOR o APROBADA) por
-- proyecto/anio/mes. Las ANULADAS quedan como historia y no bloquean.
-- Se implementa con columna generada que vale NULL cuando esta anulada
-- (MySQL permite multiples NULL en un indice UNIQUE).
-- ---------------------------------------------------------------------
CREATE TABLE tarifas_kwh (
  id_tarifa      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_proyecto    INT UNSIGNED NOT NULL,
  anio           SMALLINT UNSIGNED NOT NULL,
  mes            TINYINT UNSIGNED NOT NULL,
  costo_kwh      DECIMAL(12,6) NOT NULL,
  moneda         CHAR(3) NOT NULL DEFAULT 'GTQ',
  estado         ENUM('BORRADOR','APROBADA','ANULADA') NOT NULL DEFAULT 'BORRADOR',
  origen         ENUM('MANUAL','COPIA_MES_ANTERIOR','IMPORTACION') NOT NULL DEFAULT 'MANUAL',
  motivo         VARCHAR(500) NULL,
  creado_por     INT UNSIGNED NULL,
  aprobado_por   INT UNSIGNED NULL,
  anulado_por    INT UNSIGNED NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_aprobacion DATETIME NULL,
  fecha_anulacion  DATETIME NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by     INT UNSIGNED NULL,
  clave_vigente  VARCHAR(40) GENERATED ALWAYS AS
      (IF(estado = 'ANULADA', NULL, CONCAT(id_proyecto, '-', anio, '-', mes))) STORED,
  PRIMARY KEY (id_tarifa),
  UNIQUE KEY uk_tarifa_vigente (clave_vigente),
  KEY ix_tarifas_periodo (id_proyecto, anio, mes, estado),
  CONSTRAINT fk_tarifas_proyecto  FOREIGN KEY (id_proyecto)  REFERENCES proyectos(id_proyecto),
  CONSTRAINT fk_tarifas_creador   FOREIGN KEY (creado_por)   REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
  CONSTRAINT fk_tarifas_aprobador FOREIGN KEY (aprobado_por) REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
  CONSTRAINT ck_tarifas_mes   CHECK (mes BETWEEN 1 AND 12),
  CONSTRAINT ck_tarifas_anio  CHECK (anio BETWEEN 2000 AND 2100),
  CONSTRAINT ck_tarifas_costo CHECK (costo_kwh >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Proyecciones mensuales de generacion (kWh). NUNCA se mezclan con tarifas.
-- ---------------------------------------------------------------------
CREATE TABLE proyecciones_kwh (
  id_proyeccion  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_proyecto    INT UNSIGNED NOT NULL,
  anio           SMALLINT UNSIGNED NOT NULL,
  mes            TINYINT UNSIGNED NOT NULL,
  proyeccion_kwh DECIMAL(18,4) NOT NULL,
  estado         ENUM('BORRADOR','APROBADA','ANULADA') NOT NULL DEFAULT 'BORRADOR',
  origen         ENUM('MANUAL','IMPORTACION','COPIA_ANIO') NOT NULL DEFAULT 'MANUAL',
  comentarios    VARCHAR(500) NULL,
  creado_por     INT UNSIGNED NULL,
  aprobado_por   INT UNSIGNED NULL,
  fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_aprobacion DATETIME NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by     INT UNSIGNED NULL,
  clave_vigente  VARCHAR(40) GENERATED ALWAYS AS
      (IF(estado = 'ANULADA', NULL, CONCAT(id_proyecto, '-', anio, '-', mes))) STORED,
  PRIMARY KEY (id_proyeccion),
  UNIQUE KEY uk_proyeccion_vigente (clave_vigente),
  KEY ix_proy_periodo (id_proyecto, anio, mes, estado),
  CONSTRAINT fk_proyecciones_proyecto FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto),
  CONSTRAINT ck_proyecciones_mes CHECK (mes BETWEEN 1 AND 12),
  CONSTRAINT ck_proyecciones_kwh CHECK (proyeccion_kwh >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Cierre mensual por proyecto. Un mes CERRADO no admite cambios de tarifa,
-- produccion ni recalculos sin reapertura autorizada y motivo.
-- ---------------------------------------------------------------------
CREATE TABLE cierres_mensuales (
  id_cierre     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_proyecto   INT UNSIGNED NOT NULL,
  anio          SMALLINT UNSIGNED NOT NULL,
  mes           TINYINT UNSIGNED NOT NULL,
  estado        ENUM('ABIERTO','CERRADO') NOT NULL DEFAULT 'CERRADO',
  cerrado_por   INT UNSIGNED NULL,
  fecha_cierre  DATETIME NULL,
  reabierto_por INT UNSIGNED NULL,
  fecha_reapertura DATETIME NULL,
  motivo        VARCHAR(500) NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_cierre),
  UNIQUE KEY uk_cierre (id_proyecto, anio, mes),
  CONSTRAINT fk_cierres_proyecto FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE CASCADE,
  CONSTRAINT ck_cierres_mes CHECK (mes BETWEEN 1 AND 12)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Produccion energetica.
--
-- `nivel_detalle` evita el doble conteo entre el consolidado de proyecto y
-- el detalle por inversor:
--   POR_INVERSOR         -> id_inversor NOT NULL
--   PROYECTO_CONSOLIDADO -> id_inversor NULL
--
-- Regla de unicidad documentada (idempotencia de cargas y sincronizaciones):
--   (id_proyecto, inversor_key, fecha, granularidad, origen, secuencia)
-- donde inversor_key = COALESCE(id_inversor, 0) y `secuencia` distingue las
-- multiples filas legitimas de una misma planta/mes del Excel historico
-- (componentes), sin tratarlas como duplicados automaticos.
-- ---------------------------------------------------------------------
CREATE TABLE produccion (
  id_produccion  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_proyecto    INT UNSIGNED NOT NULL,
  id_inversor    INT UNSIGNED NULL,
  nivel_detalle  ENUM('POR_INVERSOR','PROYECTO_CONSOLIDADO') NOT NULL,
  fecha          DATE NOT NULL COMMENT 'En granularidad MENSUAL se usa el dia 1 del mes',
  anio           SMALLINT UNSIGNED NOT NULL,
  mes            TINYINT UNSIGNED NOT NULL,
  granularidad   ENUM('DIARIA','MENSUAL') NOT NULL DEFAULT 'MENSUAL',
  kwh            DECIMAL(18,4) NOT NULL,
  origen         ENUM('MANUAL','HUAWEI_API','AJUSTE') NOT NULL DEFAULT 'MANUAL',
  secuencia      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  id_historico   BIGINT UNSIGNED NULL,
  id_sync        BIGINT UNSIGNED NULL,
  id_tarifa      INT UNSIGNED NULL,
  costo_kwh_aplicado DECIMAL(12,6) NULL,
  valor_q        DECIMAL(18,4) NULL,
  estado_valorizacion ENUM('VALORIZADA','PENDIENTE_DE_TARIFA') NOT NULL DEFAULT 'PENDIENTE_DE_TARIFA',
  comentarios    VARCHAR(500) NULL,
  activo         TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT UNSIGNED NULL,
  updated_by     INT UNSIGNED NULL,
  inversor_key   INT UNSIGNED GENERATED ALWAYS AS (COALESCE(id_inversor, 0)) STORED,
  PRIMARY KEY (id_produccion),
  UNIQUE KEY uk_produccion (id_proyecto, inversor_key, fecha, granularidad, origen, secuencia),
  KEY ix_prod_fecha (fecha),
  KEY ix_prod_periodo (id_proyecto, anio, mes),
  KEY ix_prod_inversor_fecha (id_inversor, fecha),
  KEY ix_prod_valorizacion (estado_valorizacion),
  KEY ix_prod_nivel (id_proyecto, nivel_detalle, granularidad, fecha),
  KEY ix_prod_historico (id_historico),
  KEY ix_prod_sync (id_sync),
  CONSTRAINT fk_prod_proyecto FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto),
  CONSTRAINT fk_prod_inversor FOREIGN KEY (id_inversor) REFERENCES inversores(id_inversor),
  CONSTRAINT fk_prod_tarifa   FOREIGN KEY (id_tarifa)   REFERENCES tarifas_kwh(id_tarifa) ON DELETE SET NULL,
  CONSTRAINT ck_prod_kwh CHECK (kwh >= 0),
  CONSTRAINT ck_prod_mes CHECK (mes BETWEEN 1 AND 12),
  CONSTRAINT ck_prod_nivel CHECK (
    (nivel_detalle = 'POR_INVERSOR' AND id_inversor IS NOT NULL) OR
    (nivel_detalle = 'PROYECTO_CONSOLIDADO' AND id_inversor IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de correcciones manuales de produccion (auditoria antes/despues).
CREATE TABLE produccion_ajustes (
  id_ajuste     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_produccion BIGINT UNSIGNED NOT NULL,
  kwh_antes     DECIMAL(18,4) NULL,
  kwh_despues   DECIMAL(18,4) NULL,
  valor_antes   DECIMAL(18,4) NULL,
  valor_despues DECIMAL(18,4) NULL,
  motivo        VARCHAR(500) NOT NULL,
  id_usuario    INT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_ajuste),
  KEY ix_ajustes_produccion (id_produccion),
  CONSTRAINT fk_ajustes_produccion FOREIGN KEY (id_produccion) REFERENCES produccion(id_produccion) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
