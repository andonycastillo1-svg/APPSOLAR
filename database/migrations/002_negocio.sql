-- =====================================================================
-- 002_negocio.sql  |  Clientes, proyectos, inversores y APIs de fabricante
-- =====================================================================

CREATE TABLE clientes (
  id_cliente   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre       VARCHAR(160) NOT NULL,
  nit          VARCHAR(30)  NOT NULL,
  ubicacion    VARCHAR(255) NULL,
  contacto     VARCHAR(120) NULL,
  telefono     VARCHAR(40)  NULL,
  email        VARCHAR(160) NULL,
  activo       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT UNSIGNED NULL,
  updated_by   INT UNSIGNED NULL,
  PRIMARY KEY (id_cliente),
  UNIQUE KEY uk_clientes_nit (nit),
  KEY ix_clientes_nombre (nombre),
  KEY ix_clientes_activo (activo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE proyectos (
  id_proyecto        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_cliente         INT UNSIGNED NOT NULL,
  nombre             VARCHAR(160) NOT NULL,
  ubicacion          VARCHAR(255) NULL,
  -- Modalidad comercial observada en los historicos (PPA / EPC / ...)
  tipo_proyecto      ENUM('PPA','EPC','AUTOCONSUMO','OTRO') NOT NULL DEFAULT 'OTRO',
  capacidad_kwp      DECIMAL(14,3) NULL COMMENT 'Potencia instalada en kWp (nunca kWh)',
  fecha_inicio       DATE NULL,
  -- Valor unicamente de referencia/compatibilidad. La valorizacion oficial
  -- SIEMPRE usa `tarifas_kwh` (tarifa mensual aprobada).
  tarifa_kwh_referencia DECIMAL(12,6) NULL,
  observaciones      VARCHAR(500) NULL,
  activo             TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT UNSIGNED NULL,
  updated_by   INT UNSIGNED NULL,
  PRIMARY KEY (id_proyecto),
  UNIQUE KEY uk_proyectos_nombre (nombre),
  KEY ix_proyectos_cliente (id_cliente),
  KEY ix_proyectos_activo (activo),
  CONSTRAINT fk_proyectos_cliente FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente),
  CONSTRAINT ck_proyectos_capacidad CHECK (capacidad_kwp IS NULL OR capacidad_kwp >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE apis_fabricante (
  id_api        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  marca         VARCHAR(60)  NOT NULL,
  nombre        VARCHAR(120) NOT NULL,
  endpoint      VARCHAR(255) NOT NULL,
  ip_autorizada VARCHAR(64)  NULL COMMENT 'IP publica del VPS autorizada por el fabricante',
  usuario_api   VARCHAR(120) NULL,
  -- NUNCA se almacena el secreto en claro: solo la referencia a la variable de
  -- entorno o al almacen de secretos donde reside.
  secreto_ref   VARCHAR(120) NULL,
  modo          ENUM('MOCK','REAL') NOT NULL DEFAULT 'MOCK',
  estado        ENUM('ACTIVA','INACTIVA','PENDIENTE_AUTORIZACION') NOT NULL DEFAULT 'PENDIENTE_AUTORIZACION',
  timeout_s     INT UNSIGNED NOT NULL DEFAULT 40,
  max_reintentos INT UNSIGNED NOT NULL DEFAULT 3,
  sync_programada TINYINT(1) NOT NULL DEFAULT 0,
  sync_hora     VARCHAR(5) NULL COMMENT 'HH:MM en zona America/Guatemala',
  ultima_prueba DATETIME NULL,
  resultado_ultima_prueba VARCHAR(255) NULL,
  ultima_sincronizacion   DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by   INT UNSIGNED NULL,
  PRIMARY KEY (id_api),
  UNIQUE KEY uk_api_marca_nombre (marca, nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inversores (
  id_inversor     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_proyecto     INT UNSIGNED NOT NULL,
  marca           VARCHAR(60)  NOT NULL,
  modelo          VARCHAR(80)  NOT NULL,
  tipo_conexion   ENUM('MANUAL','HUAWEI_API') NOT NULL DEFAULT 'MANUAL',
  -- Extensiones de implementacion (documentadas en docs/modelo-datos.md)
  serial_externo  VARCHAR(80)  NULL COMMENT 'Serial / deviceDn / stationCode del fabricante',
  estacion_externa VARCHAR(80) NULL COMMENT 'stationCode Huawei al que pertenece',
  capacidad_kwp   DECIMAL(14,3) NULL,
  estado          ENUM('ACTIVO','INACTIVO','MANTENIMIENTO') NOT NULL DEFAULT 'ACTIVO',
  id_api          INT UNSIGNED NULL,
  ultima_actualizacion DATETIME NULL COMMENT 'Fecha del ultimo dato de produccion disponible',
  observaciones   VARCHAR(500) NULL,
  activo          TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT UNSIGNED NULL,
  updated_by   INT UNSIGNED NULL,
  PRIMARY KEY (id_inversor),
  UNIQUE KEY uk_inversor_serial (id_proyecto, serial_externo),
  KEY ix_inversores_proyecto (id_proyecto),
  KEY ix_inversores_tipo (tipo_conexion),
  KEY ix_inversores_activo (activo),
  CONSTRAINT fk_inversores_proyecto FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto),
  CONSTRAINT fk_inversores_api FOREIGN KEY (id_api) REFERENCES apis_fabricante(id_api) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
