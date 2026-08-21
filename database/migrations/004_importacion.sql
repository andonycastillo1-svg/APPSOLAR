-- =====================================================================
-- 004_importacion.sql | Importaciones, sincronizaciones y reportes
-- =====================================================================

CREATE TABLE historicos (
  id_historico   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_proyecto    INT UNSIGNED NULL,
  id_inversor    INT UNSIGNED NULL,
  formato        ENUM('NORMALIZADO','HISTORICO_EXCEL') NOT NULL,
  nivel_detalle  ENUM('POR_INVERSOR','PROYECTO_CONSOLIDADO') NOT NULL,
  nombre_archivo_original VARCHAR(255) NOT NULL,
  nombre_archivo_seguro   VARCHAR(160) NOT NULL,
  hash_sha256    CHAR(64) NOT NULL,
  tamano_bytes   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mime_detectado VARCHAR(120) NULL,
  id_usuario     INT UNSIGNED NULL,
  estado ENUM('PENDIENTE','VALIDANDO','VALIDADO','PROCESANDO','COMPLETADO',
              'COMPLETADO_CON_ERRORES','FALLIDO','RECHAZADO','EXPIRADO')
         NOT NULL DEFAULT 'PENDIENTE',
  total_filas    INT UNSIGNED NOT NULL DEFAULT 0,
  insertadas     INT UNSIGNED NOT NULL DEFAULT 0,
  actualizadas   INT UNSIGNED NOT NULL DEFAULT 0,
  duplicadas     INT UNSIGNED NOT NULL DEFAULT 0,
  rechazadas     INT UNSIGNED NOT NULL DEFAULT 0,
  advertencias   INT UNSIGNED NOT NULL DEFAULT 0,
  fecha_min      DATE NULL,
  fecha_max      DATE NULL,
  politica_duplicados ENUM('OMITIR','ACTUALIZAR') NOT NULL DEFAULT 'ACTUALIZAR',
  decisiones     JSON NULL COMMENT 'Decisiones tomadas por el usuario en el asistente',
  resumen        JSON NULL,
  mensaje        VARCHAR(500) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  confirmado_en  DATETIME NULL,
  PRIMARY KEY (id_historico),
  KEY ix_hist_proyecto (id_proyecto),
  KEY ix_hist_inversor (id_inversor),
  KEY ix_hist_estado (estado),
  KEY ix_hist_fecha (created_at),
  KEY ix_hist_hash (hash_sha256),
  CONSTRAINT fk_hist_proyecto FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE SET NULL,
  CONSTRAINT fk_hist_inversor FOREIGN KEY (id_inversor) REFERENCES inversores(id_inversor) ON DELETE SET NULL,
  CONSTRAINT fk_hist_usuario  FOREIGN KEY (id_usuario)  REFERENCES usuarios(id_usuario) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE historico_errores (
  id_error     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_historico BIGINT UNSIGNED NOT NULL,
  fila         INT UNSIGNED NULL,
  columna      VARCHAR(60) NULL,
  valor        VARCHAR(255) NULL,
  codigo       VARCHAR(60) NOT NULL,
  severidad    ENUM('ERROR','ADVERTENCIA') NOT NULL DEFAULT 'ERROR',
  mensaje      VARCHAR(500) NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_error),
  KEY ix_herr_historico (id_historico, severidad),
  CONSTRAINT fk_herr_historico FOREIGN KEY (id_historico) REFERENCES historicos(id_historico) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sincronizaciones (
  id_sync       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_api        INT UNSIGNED NULL,
  id_proyecto   INT UNSIGNED NULL,
  id_inversor   INT UNSIGNED NULL,
  tipo          ENUM('MANUAL','PROGRAMADA','PRUEBA') NOT NULL DEFAULT 'MANUAL',
  modo          ENUM('MOCK','REAL') NOT NULL DEFAULT 'MOCK',
  estado        ENUM('EN_PROCESO','COMPLETADA','COMPLETADA_CON_ERRORES','FALLIDA')
                NOT NULL DEFAULT 'EN_PROCESO',
  rango_desde   DATE NULL,
  rango_hasta   DATE NULL,
  granularidad  ENUM('DIARIA','MENSUAL') NOT NULL DEFAULT 'DIARIA',
  filas_recibidas INT UNSIGNED NOT NULL DEFAULT 0,
  insertadas    INT UNSIGNED NOT NULL DEFAULT 0,
  actualizadas  INT UNSIGNED NOT NULL DEFAULT 0,
  rechazadas    INT UNSIGNED NOT NULL DEFAULT 0,
  duracion_ms   INT UNSIGNED NULL,
  codigo_error  VARCHAR(60) NULL,
  mensaje       VARCHAR(500) NULL,
  detalle       JSON NULL,
  id_usuario    INT UNSIGNED NULL,
  iniciada_en   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalizada_en DATETIME NULL,
  PRIMARY KEY (id_sync),
  KEY ix_sync_estado (estado),
  KEY ix_sync_fecha (iniciada_en),
  KEY ix_sync_proyecto (id_proyecto),
  KEY ix_sync_inversor (id_inversor),
  CONSTRAINT fk_sync_api       FOREIGN KEY (id_api)      REFERENCES apis_fabricante(id_api) ON DELETE SET NULL,
  CONSTRAINT fk_sync_proyecto  FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE SET NULL,
  CONSTRAINT fk_sync_inversor  FOREIGN KEY (id_inversor) REFERENCES inversores(id_inversor) ON DELETE SET NULL,
  CONSTRAINT fk_sync_usuario   FOREIGN KEY (id_usuario)  REFERENCES usuarios(id_usuario) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reportes (
  id_reporte    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_usuario    INT UNSIGNED NULL,
  tipo          ENUM('PRODUCCION','RESUMEN_ANUAL','COMPARATIVO','VALORIZACION') NOT NULL,
  nombre        VARCHAR(160) NOT NULL,
  parametros    JSON NOT NULL,
  periodo_desde DATE NULL,
  periodo_hasta DATE NULL,
  resumen       JSON NULL,
  cobertura_tarifaria ENUM('COMPLETA','PARCIAL') NOT NULL DEFAULT 'COMPLETA',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_reporte),
  KEY ix_rep_usuario (id_usuario),
  KEY ix_rep_fecha (created_at),
  KEY ix_rep_tipo (tipo),
  CONSTRAINT fk_rep_usuario FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Claves foraneas diferidas de `produccion` hacia los lotes de origen.
ALTER TABLE produccion
  ADD CONSTRAINT fk_prod_historico FOREIGN KEY (id_historico) REFERENCES historicos(id_historico) ON DELETE SET NULL,
  ADD CONSTRAINT fk_prod_sync      FOREIGN KEY (id_sync)      REFERENCES sincronizaciones(id_sync) ON DELETE SET NULL;
