-- =====================================================================
-- 007_paneles_grupo.sql
--
-- Lotes de paneles solares por grupo de inversores.
--
-- Motivo: una instalacion que lleva varios anios en operacion suele tener
-- paneles de distintas generaciones dentro del MISMO grupo -- por ejemplo,
-- paneles originales de 440 Wp y, tras una ampliacion, paneles nuevos de
-- 640 Wp con las mismas dimensiones fisicas. Un solo campo de "cantidad de
-- paneles" y "capacidad" no alcanza para representar eso sin perder
-- informacion ni obligar a recalcular el total a mano cada vez.
--
-- Cada fila de `paneles_grupo` es un LOTE: una cantidad de paneles con la
-- misma potencia unitaria, instalados (opcionalmente) en una fecha
-- determinada. La cantidad total de paneles y la potencia instalada en kWp
-- de un grupo se OBTIENEN SUMANDO sus lotes activos -- no se guardan como
-- columna redundante en `grupos`, siguiendo el mismo criterio que ya usa el
-- resto del sistema para totales agregados (se calculan en la consulta).
--
-- El total a nivel de PROYECTO es, a su vez, la suma de los lotes de todos
-- sus grupos: este dato se captura unicamente en el grupo, nunca de forma
-- independiente en el proyecto.
--
-- Esto es ortogonal a `grupos.capacidad_kwp` (potencia declarada por el
-- operador, ya existente desde la migracion 006): esa columna no se toca ni
-- se reemplaza. El total derivado de los lotes se expone por separado en la
-- API como una cifra adicional, mas granular y trazable.
--
-- IMPORTANTE: la produccion de energia (tabla `produccion`) NO cambia con
-- esta migracion. Sigue acumulandose por PROYECTO (y por grupo, para el
-- caso de cargas manuales), nunca por inversor ni por panel individual.
-- =====================================================================

CREATE TABLE paneles_grupo (
  id_lote            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_grupo           INT UNSIGNED NOT NULL,
  -- Cantidad de paneles de ESTE lote (misma potencia unitaria).
  cantidad           SMALLINT UNSIGNED NOT NULL,
  -- Potencia pico de CADA panel del lote, en vatios (Wp). Ej.: 440.00, 640.00.
  potencia_wp        DECIMAL(8,2) NOT NULL,
  marca              VARCHAR(80) NULL,
  modelo             VARCHAR(120) NULL,
  -- Opcional: cuando se instalo este lote (permite distinguir la
  -- instalacion original de ampliaciones posteriores).
  fecha_instalacion  DATE NULL,
  observaciones      VARCHAR(500) NULL,
  activo             TINYINT(1) NOT NULL DEFAULT 1,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT UNSIGNED NULL,
  updated_by         INT UNSIGNED NULL,
  PRIMARY KEY (id_lote),
  KEY ix_paneles_grupo (id_grupo),
  KEY ix_paneles_activo (activo),
  CONSTRAINT fk_paneles_grupo FOREIGN KEY (id_grupo) REFERENCES grupos(id_grupo),
  CONSTRAINT ck_paneles_cantidad CHECK (cantidad > 0),
  CONSTRAINT ck_paneles_potencia CHECK (potencia_wp > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
