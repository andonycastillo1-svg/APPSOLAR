/**
 * Catalogo de permisos y matriz RBAC.
 * Esta constante debe mantenerse alineada con `database/migrations/005_catalogos.sql`.
 * La prueba `tests/rbac.test.ts` verifica que ambos origenes coincidan.
 */

export const PERMISOS = {
  USUARIOS_VER: 'usuarios.ver',
  USUARIOS_GESTIONAR: 'usuarios.gestionar',
  CLIENTES_VER: 'clientes.ver',
  CLIENTES_GESTIONAR: 'clientes.gestionar',
  PROYECTOS_VER: 'proyectos.ver',
  PROYECTOS_GESTIONAR: 'proyectos.gestionar',
  INVERSORES_VER: 'inversores.ver',
  INVERSORES_GESTIONAR: 'inversores.gestionar',
  PRODUCCION_VER: 'produccion.ver',
  PRODUCCION_REGISTRAR: 'produccion.registrar',
  PRODUCCION_CORREGIR: 'produccion.corregir',
  IMPORTACIONES_VER: 'importaciones.ver',
  IMPORTACIONES_CARGAR: 'importaciones.cargar',
  TARIFAS_VER: 'tarifas.ver',
  TARIFAS_GESTIONAR: 'tarifas.gestionar',
  TARIFAS_APROBAR: 'tarifas.aprobar',
  TARIFAS_RECALCULAR: 'tarifas.recalcular',
  TARIFAS_CERRAR_MES: 'tarifas.cerrar_mes',
  TARIFAS_REABRIR_MES: 'tarifas.reabrir_mes',
  PROYECCIONES_VER: 'proyecciones.ver',
  PROYECCIONES_GESTIONAR: 'proyecciones.gestionar',
  PROYECCIONES_APROBAR: 'proyecciones.aprobar',
  HUAWEI_VER: 'huawei.ver',
  HUAWEI_CONFIGURAR: 'huawei.configurar',
  HUAWEI_SINCRONIZAR: 'huawei.sincronizar',
  PRODUCCION_SINCRONIZAR_AHORA: 'produccion.sincronizar_ahora',
  DASHBOARD_VER: 'dashboard.ver',
  REPORTES_VER: 'reportes.ver',
  REPORTES_GENERAR: 'reportes.generar',
  REPORTES_EXPORTAR: 'reportes.exportar',
  AUDITORIA_VER: 'auditoria.ver',
  CONFIG_VER: 'config.ver',
  CONFIG_GESTIONAR: 'config.gestionar',
  SALUD_VER: 'salud.ver',
} as const;

export type Permiso = (typeof PERMISOS)[keyof typeof PERMISOS];

export const TODOS_LOS_PERMISOS: Permiso[] = Object.values(PERMISOS);

export type RolCodigo = 'ADMINISTRATIVO' | 'OPERATIVO' | 'GERENCIAL';

export const PERMISOS_POR_ROL: Record<RolCodigo, Permiso[]> = {
  ADMINISTRATIVO: TODOS_LOS_PERMISOS,

  // El operativo gestiona toda la informacion del negocio (clientes, proyectos,
  // grupos, inversores, produccion, historicos, proyecciones y tarifas) y puede
  // sincronizar. NO administra el sistema: usuarios, permisos, auditoria,
  // configuracion, respaldos ni credenciales de la integracion.
  OPERATIVO: [
    PERMISOS.CLIENTES_VER,
    PERMISOS.CLIENTES_GESTIONAR,
    PERMISOS.PROYECTOS_VER,
    PERMISOS.PROYECTOS_GESTIONAR,
    PERMISOS.INVERSORES_VER,
    PERMISOS.INVERSORES_GESTIONAR,
    PERMISOS.PRODUCCION_VER,
    PERMISOS.PRODUCCION_REGISTRAR,
    PERMISOS.PRODUCCION_CORREGIR,
    PERMISOS.IMPORTACIONES_VER,
    PERMISOS.IMPORTACIONES_CARGAR,
    PERMISOS.TARIFAS_VER,
    PERMISOS.TARIFAS_GESTIONAR,
    PERMISOS.TARIFAS_APROBAR,
    PERMISOS.TARIFAS_RECALCULAR,
    PERMISOS.TARIFAS_CERRAR_MES,
    PERMISOS.TARIFAS_REABRIR_MES,
    PERMISOS.PROYECCIONES_VER,
    PERMISOS.PROYECCIONES_GESTIONAR,
    PERMISOS.PROYECCIONES_APROBAR,
    PERMISOS.HUAWEI_VER,
    PERMISOS.HUAWEI_SINCRONIZAR,
    PERMISOS.PRODUCCION_SINCRONIZAR_AHORA,
    PERMISOS.DASHBOARD_VER,
    PERMISOS.REPORTES_VER,
    PERMISOS.REPORTES_GENERAR,
    PERMISOS.REPORTES_EXPORTAR,
  ],

  // Solo lectura, salvo el boton "Sincronizar ahora" (produccion.sincronizar_ahora).
  GERENCIAL: [
    PERMISOS.CLIENTES_VER,
    PERMISOS.PROYECTOS_VER,
    PERMISOS.INVERSORES_VER,
    PERMISOS.PRODUCCION_VER,
    PERMISOS.TARIFAS_VER,
    PERMISOS.PROYECCIONES_VER,
    PERMISOS.IMPORTACIONES_VER,
    // Unica accion que no es lectura: refrescar los datos desde el fabricante.
    PERMISOS.PRODUCCION_SINCRONIZAR_AHORA,
    PERMISOS.DASHBOARD_VER,
    PERMISOS.REPORTES_VER,
    PERMISOS.REPORTES_GENERAR,
    PERMISOS.REPORTES_EXPORTAR,
  ],
};

/** Permisos que jamas pueden otorgarse individualmente a un rol gerencial. */
export const PERMISOS_SOLO_ESCRITURA: Permiso[] = TODOS_LOS_PERMISOS.filter(
  (p) => !p.endsWith('.ver'),
);
