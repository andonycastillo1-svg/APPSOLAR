-- ============================================================================
-- Correccion UNICA de las horas ya guardadas en el hosting (UTC -> hora de Guatemala)
--
-- Contexto: antes de esta version, el servidor de base de datos del hosting guardaba NOW()
-- en su propia zona (UTC) y algunas fechas de aprobacion se escribian en UTC desde Node.
-- Desde ahora toda sesion trabaja en -06:00 (America/Guatemala), por lo que los registros
-- NUEVOS ya salen correctos. Este script solo corrige los registros ANTIGUOS.
--
-- ANTES DE EJECUTAR
--   1. Descargue un respaldo desde Configuracion -> Descargar copia de respaldo.
--   2. Compruebe que los datos antiguos estan en UTC:
--        SELECT NOW() AS hora_servidor, UTC_TIMESTAMP() AS utc;
--      Si ambas columnas muestran la MISMA hora, el servidor esta en UTC y este script aplica.
--      Si no coinciden, NO lo ejecute y consulte primero.
--   3. Ejecute este script UNA SOLA VEZ, despues de publicar la nueva version. Repetirlo
--      restaria seis horas de nuevo.
--
-- La tabla de control `correccion_horas_aplicada` registra que ya se ejecuto (revise el paso c).
-- ============================================================================

CREATE TABLE IF NOT EXISTS correccion_horas_aplicada (
  id INT PRIMARY KEY,
  aplicada_en DATETIME NOT NULL
);

-- Si esta consulta devuelve una fila, la correccion ya se aplico: NO continue.
SELECT * FROM correccion_horas_aplicada;

-- Corrige solo las columnas de sello de tiempo (created_at, updated_at, fecha_*, ultimo_acceso, etc.).
-- Las columnas DATE (sin hora) no se tocan.
SELECT CONCAT('UPDATE `', table_name, '` SET ',
              GROUP_CONCAT(CONCAT('`', column_name, '` = DATE_SUB(`', column_name, '`, INTERVAL 6 HOUR)')
                           SEPARATOR ', '), ';') AS sentencia_a_ejecutar
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND data_type IN ('datetime', 'timestamp')
   AND table_name NOT IN ('correccion_horas_aplicada', '_migraciones')
 GROUP BY table_name;

-- PASOS:
--  a) Ejecute el SELECT de arriba: devuelve una sentencia UPDATE por tabla.
--  b) Copie y ejecute esas sentencias (todas, en una sola vez).
--  c) Marque la correccion como aplicada:
--       INSERT INTO correccion_horas_aplicada (id, aplicada_en) VALUES (1, NOW());
--  d) Verifique en la interfaz y en la tabla `auditoria`: ambas horas deben coincidir.
