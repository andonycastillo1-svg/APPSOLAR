-- =====================================================================
-- 011_paneles_por_inversor.sql
--
-- Paneles instalados por inversor. Por norma, un inversor lleva una
-- cantidad N de paneles de la MISMA potencia, de modo que se registran dos
-- datos: cuantos paneles tiene y de cuantos vatios pico (Wp) es cada uno.
--
-- El total de paneles de un grupo y del proyecto se obtiene sumando los
-- inversores. Los lotes de `paneles_grupo` (migracion 007) siguen sirviendo
-- cuando no se conoce el detalle por inversor: un grupo cuyos inversores
-- tienen paneles registrados usa ese detalle y NO suma los lotes (evita el
-- doble conteo).
-- =====================================================================

ALTER TABLE inversores
  ADD COLUMN cantidad_paneles SMALLINT UNSIGNED NULL
    COMMENT 'Cantidad de paneles instalados en este inversor' AFTER capacidad_kwp,
  ADD COLUMN potencia_panel_wp DECIMAL(8,2) NULL
    COMMENT 'Potencia pico de cada panel en Wp' AFTER cantidad_paneles,
  ADD CONSTRAINT ck_inversores_paneles CHECK (
    (cantidad_paneles IS NULL AND potencia_panel_wp IS NULL)
    OR (cantidad_paneles > 0 AND potencia_panel_wp > 0)
  );
