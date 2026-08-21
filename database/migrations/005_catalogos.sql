-- =====================================================================
-- 005_catalogos.sql | Datos de referencia: roles, permisos y configuracion
-- Estos NO son datos de demostracion: son catalogos obligatorios del sistema.
-- =====================================================================

INSERT INTO roles (codigo, nombre, descripcion) VALUES
  ('ADMINISTRATIVO', 'Usuario administrativo', 'Administra usuarios, catalogos, integracion, tarifas y auditoria.'),
  ('OPERATIVO',      'Usuario operativo',      'Registra inversores, carga historicos, sincroniza y consulta produccion.'),
  ('GERENCIAL',      'Usuario gerencial',      'Acceso de solo lectura a informacion consolidada, reportes e indicadores.');

INSERT INTO permisos (codigo, modulo, descripcion) VALUES
  ('usuarios.ver',           'Usuarios',      'Consultar usuarios y sus permisos'),
  ('usuarios.gestionar',     'Usuarios',      'Crear, editar, activar/desactivar y restablecer usuarios'),
  ('clientes.ver',           'Clientes',      'Consultar clientes'),
  ('clientes.gestionar',     'Clientes',      'Crear, editar y desactivar clientes'),
  ('proyectos.ver',          'Proyectos',     'Consultar proyectos solares'),
  ('proyectos.gestionar',    'Proyectos',     'Crear, editar y desactivar proyectos solares'),
  ('inversores.ver',         'Inversores',    'Consultar inversores'),
  ('inversores.gestionar',   'Inversores',    'Crear, editar y desactivar inversores'),
  ('produccion.ver',         'Produccion',    'Consultar registros de produccion energetica'),
  ('produccion.registrar',   'Produccion',    'Registrar produccion manualmente'),
  ('produccion.corregir',    'Produccion',    'Corregir registros de produccion con motivo y auditoria'),
  ('importaciones.ver',      'Importaciones', 'Consultar el historial de importaciones'),
  ('importaciones.cargar',   'Importaciones', 'Cargar, previsualizar y confirmar archivos historicos'),
  ('tarifas.ver',            'Tarifas',       'Consultar tarifas mensuales de kWh'),
  ('tarifas.gestionar',      'Tarifas',       'Registrar y editar tarifas mensuales en estado BORRADOR'),
  ('tarifas.aprobar',        'Tarifas',       'Aprobar o anular tarifas mensuales'),
  ('tarifas.recalcular',     'Tarifas',       'Corregir tarifas ya utilizadas y recalcular la valorizacion'),
  ('tarifas.cerrar_mes',     'Tarifas',       'Cerrar un periodo mensual de un proyecto'),
  ('tarifas.reabrir_mes',    'Tarifas',       'Reabrir un periodo mensual cerrado (requiere motivo)'),
  ('proyecciones.ver',       'Proyecciones',  'Consultar proyecciones mensuales de generacion'),
  ('proyecciones.gestionar', 'Proyecciones',  'Registrar, importar y copiar proyecciones mensuales'),
  ('proyecciones.aprobar',   'Proyecciones',  'Aprobar o anular proyecciones mensuales'),
  ('huawei.ver',             'Integracion',   'Consultar configuracion y ejecuciones de la integracion Huawei'),
  ('huawei.configurar',      'Integracion',   'Configurar la integracion Huawei SmartPVMS'),
  ('huawei.sincronizar',     'Integracion',   'Ejecutar pruebas de conexion y sincronizaciones'),
  ('dashboard.ver',          'Dashboard',     'Consultar el tablero de indicadores'),
  ('reportes.ver',           'Reportes',      'Consultar reportes generados'),
  ('reportes.generar',       'Reportes',      'Generar reportes'),
  ('reportes.exportar',      'Reportes',      'Exportar e imprimir reportes (PDF/CSV/XLSX)'),
  ('auditoria.ver',          'Auditoria',     'Consultar la bitacora de auditoria'),
  ('config.ver',             'Configuracion', 'Consultar parametros generales del sistema'),
  ('config.gestionar',       'Configuracion', 'Modificar parametros generales del sistema'),
  ('salud.ver',              'Operacion',     'Consultar el estado detallado de los servicios');

-- ADMINISTRATIVO: todos los permisos.
INSERT INTO rol_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso FROM roles r CROSS JOIN permisos p WHERE r.codigo = 'ADMINISTRATIVO';

-- OPERATIVO: operacion diaria. NO incluye `tarifas.gestionar` por defecto:
-- ese permiso se otorga individualmente al coordinador (usuario_permisos).
INSERT INTO rol_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso FROM roles r JOIN permisos p
WHERE r.codigo = 'OPERATIVO' AND p.codigo IN (
  'clientes.ver','proyectos.ver','inversores.ver','inversores.gestionar',
  'produccion.ver','produccion.registrar',
  'importaciones.ver','importaciones.cargar',
  'tarifas.ver','proyecciones.ver',
  'huawei.ver','huawei.sincronizar',
  'dashboard.ver','reportes.ver','reportes.generar','reportes.exportar'
);

-- GERENCIAL: estrictamente solo lectura.
INSERT INTO rol_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso FROM roles r JOIN permisos p
WHERE r.codigo = 'GERENCIAL' AND p.codigo IN (
  'clientes.ver','proyectos.ver','inversores.ver','produccion.ver',
  'tarifas.ver','proyecciones.ver','importaciones.ver',
  'dashboard.ver','reportes.ver','reportes.generar','reportes.exportar'
);

-- ---------------------------------------------------------------------
-- Parametros generales. Los factores de equivalencia ambiental son
-- CONFIGURABLES y declaran unidad y fuente (nunca constantes ocultas).
-- ---------------------------------------------------------------------
INSERT INTO configuracion (clave, valor, tipo, categoria, descripcion, unidad, fuente, editable) VALUES
  ('carga.max_mb',            '10',    'NUMERO',  'CARGAS',    'Tamano maximo permitido por archivo de importacion', 'MB', NULL, 1),
  ('carga.extensiones',       '.csv,.xlsx', 'TEXTO', 'CARGAS',  'Extensiones permitidas para importacion', NULL, NULL, 1),
  ('carga.filas_max',         '20000', 'NUMERO',  'CARGAS',    'Numero maximo de filas de datos por archivo', 'filas', NULL, 1),
  ('sesion.minutos_acceso',   '15',    'NUMERO',  'SEGURIDAD', 'Vigencia del token de acceso', 'minutos', NULL, 1),
  ('sesion.dias_refresco',    '7',     'NUMERO',  'SEGURIDAD', 'Vigencia maxima de la sesion renovable', 'dias', NULL, 1),
  ('sesion.intentos_max',     '5',     'NUMERO',  'SEGURIDAD', 'Intentos fallidos antes del bloqueo temporal', 'intentos', NULL, 1),
  ('sesion.bloqueo_minutos',  '15',    'NUMERO',  'SEGURIDAD', 'Duracion del bloqueo temporal por intentos fallidos', 'minutos', NULL, 1),
  ('sync.programada',         'false', 'BOOLEANO','INTEGRACION','Habilita la sincronizacion Huawei programada', NULL, NULL, 1),
  ('sync.hora',               '02:30', 'TEXTO',   'INTEGRACION','Hora local (America/Guatemala) de la sincronizacion programada', 'HH:MM', NULL, 1),
  ('sync.dias_atras',         '7',     'NUMERO',  'INTEGRACION','Ventana de dias que se re-consulta en cada sincronizacion', 'dias', NULL, 1),
  ('ambiental.factor_co2',    '0.4523','NUMERO',  'AMBIENTAL', 'Factor de emision de la red electrica nacional', 'tCO2e/MWh', 'Factor de emision del Sistema Nacional Interconectado - AMM/MEM Guatemala. Ajustar al valor oficial vigente.', 1),
  ('ambiental.co2_por_arbol', '0.0217','NUMERO',  'AMBIENTAL', 'CO2 absorbido por un arbol maduro en un anio', 'tCO2e/arbol/anio', 'Valor referencial de referencia forestal; ajustar segun la fuente institucional que adopte Retse, S.A.', 1),
  ('reporte.decimales_kwh',   '2',     'NUMERO',  'REPORTES',  'Decimales para mostrar energia', 'decimales', NULL, 1),
  ('reporte.decimales_moneda','2',     'NUMERO',  'REPORTES',  'Decimales para mostrar valores monetarios', 'decimales', NULL, 1),
  ('reporte.moneda',          'GTQ',   'TEXTO',   'REPORTES',  'Moneda utilizada para la valorizacion', NULL, NULL, 0),
  ('reporte.zona_horaria',    'America/Guatemala', 'TEXTO', 'REPORTES', 'Zona horaria oficial del sistema', NULL, NULL, 0),
  ('empresa.nombre',          'Retse, S.A.', 'TEXTO', 'GENERAL', 'Nombre institucional mostrado en reportes', NULL, NULL, 1),
  ('nit.patron',              '^[0-9]{4,12}-?[0-9kK]$', 'TEXTO', 'GENERAL', 'Expresion regular para validar el NIT (configurable)', NULL, NULL, 1);
