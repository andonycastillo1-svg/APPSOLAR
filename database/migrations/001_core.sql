-- =====================================================================
-- 001_core.sql  |  Seguridad, roles, permisos, auditoria y configuracion
-- Motor: MySQL 8.0+  |  Charset: utf8mb4  |  Zona horaria: America/Guatemala
-- =====================================================================

CREATE TABLE roles (
  id_rol        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  codigo        VARCHAR(30)  NOT NULL,
  nombre        VARCHAR(80)  NOT NULL,
  descripcion   VARCHAR(255) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_rol),
  UNIQUE KEY uk_roles_codigo (codigo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE permisos (
  id_permiso    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  codigo        VARCHAR(60)  NOT NULL,
  modulo        VARCHAR(40)  NOT NULL,
  descripcion   VARCHAR(255) NOT NULL,
  PRIMARY KEY (id_permiso),
  UNIQUE KEY uk_permisos_codigo (codigo),
  KEY ix_permisos_modulo (modulo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rol_permisos (
  id_rol      INT UNSIGNED NOT NULL,
  id_permiso  INT UNSIGNED NOT NULL,
  PRIMARY KEY (id_rol, id_permiso),
  CONSTRAINT fk_rp_rol     FOREIGN KEY (id_rol)     REFERENCES roles(id_rol)       ON DELETE CASCADE,
  CONSTRAINT fk_rp_permiso FOREIGN KEY (id_permiso) REFERENCES permisos(id_permiso) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE usuarios (
  id_usuario           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre               VARCHAR(120) NOT NULL,
  email                VARCHAR(160) NOT NULL,
  password_hash        VARCHAR(255) NOT NULL,
  id_rol               INT UNSIGNED NOT NULL,
  telefono             VARCHAR(40)  NULL,
  activo               TINYINT(1)   NOT NULL DEFAULT 1,
  debe_cambiar_password TINYINT(1)  NOT NULL DEFAULT 0,
  ultimo_acceso        DATETIME     NULL,
  intentos_fallidos    INT UNSIGNED NOT NULL DEFAULT 0,
  bloqueado_hasta      DATETIME     NULL,
  password_actualizado_en DATETIME  NULL,
  es_demo              TINYINT(1)   NOT NULL DEFAULT 0,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT UNSIGNED NULL,
  updated_by           INT UNSIGNED NULL,
  PRIMARY KEY (id_usuario),
  UNIQUE KEY uk_usuarios_email (email),
  KEY ix_usuarios_rol (id_rol),
  KEY ix_usuarios_activo (activo),
  CONSTRAINT fk_usuarios_rol FOREIGN KEY (id_rol) REFERENCES roles(id_rol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Permisos otorgados o revocados de forma individual (p.ej. `tarifas.gestionar`
-- para un usuario operativo que actua como coordinador).
CREATE TABLE usuario_permisos (
  id_usuario   INT UNSIGNED NOT NULL,
  id_permiso   INT UNSIGNED NOT NULL,
  otorgado     TINYINT(1)   NOT NULL DEFAULT 1,
  asignado_por INT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_usuario, id_permiso),
  CONSTRAINT fk_up_usuario FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
  CONSTRAINT fk_up_permiso FOREIGN KEY (id_permiso) REFERENCES permisos(id_permiso) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Solo se guarda el hash del refresh token; nunca el token en claro.
CREATE TABLE refresh_tokens (
  id_token     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_usuario   INT UNSIGNED NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  familia      CHAR(36)     NOT NULL,
  expira_en    DATETIME     NOT NULL,
  revocado_en  DATETIME     NULL,
  motivo_revocacion VARCHAR(80) NULL,
  ip           VARCHAR(64)  NULL,
  user_agent   VARCHAR(255) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_token),
  UNIQUE KEY uk_rt_hash (token_hash),
  KEY ix_rt_usuario (id_usuario),
  KEY ix_rt_expira (expira_en),
  CONSTRAINT fk_rt_usuario FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE auditoria (
  id_auditoria   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_usuario     INT UNSIGNED NULL,
  usuario_email  VARCHAR(160) NULL,
  accion         VARCHAR(80)  NOT NULL,
  entidad        VARCHAR(60)  NOT NULL,
  id_entidad     VARCHAR(60)  NULL,
  resultado      ENUM('EXITO','FALLO') NOT NULL DEFAULT 'EXITO',
  datos_antes    JSON NULL,
  datos_despues  JSON NULL,
  motivo         VARCHAR(500) NULL,
  ip             VARCHAR(64)  NULL,
  user_agent     VARCHAR(255) NULL,
  correlation_id CHAR(36)     NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_auditoria),
  KEY ix_aud_fecha (created_at),
  KEY ix_aud_usuario (id_usuario),
  KEY ix_aud_entidad (entidad, id_entidad),
  KEY ix_aud_accion (accion),
  CONSTRAINT fk_aud_usuario FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE configuracion (
  clave        VARCHAR(80)  NOT NULL,
  valor        VARCHAR(500) NOT NULL,
  tipo         ENUM('TEXTO','NUMERO','BOOLEANO','JSON') NOT NULL DEFAULT 'TEXTO',
  categoria    VARCHAR(40)  NOT NULL DEFAULT 'GENERAL',
  descripcion  VARCHAR(255) NOT NULL,
  unidad       VARCHAR(40)  NULL,
  fuente       VARCHAR(255) NULL,
  editable     TINYINT(1)   NOT NULL DEFAULT 1,
  updated_by   INT UNSIGNED NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (clave),
  KEY ix_config_categoria (categoria)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bloqueo cooperativo para evitar sincronizaciones/importaciones concurrentes.
CREATE TABLE bloqueos (
  recurso     VARCHAR(120) NOT NULL,
  id_usuario  INT UNSIGNED NULL,
  detalle     VARCHAR(255) NULL,
  expira_en   DATETIME NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (recurso),
  KEY ix_bloqueos_expira (expira_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
