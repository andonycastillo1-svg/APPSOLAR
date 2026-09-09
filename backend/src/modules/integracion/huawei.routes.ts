import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { execute, query, queryOne } from '../../db/pool';
import { errores } from '../../utils/errors';
import {
  asyncHandler,
  consulta,
  esquemaPaginacion,
  limitesPaginacion,
  metaPaginacion,
  ok,
  validarConsulta,
  validarCuerpo,
} from '../../utils/http';
import { requiereAutenticacion, requierePermiso } from '../../middleware/autenticacion';
import { PERMISOS } from '../../config/permisos';
import { auditarDesdeRequest } from '../../services/auditoria';
import { probarConexion } from '../../services/huaweiCliente';
import { ejecutarSincronizacion } from '../../services/sincronizacion';
import { hoyISO } from '../../utils/fechas';

export const huaweiRouter = Router();
huaweiRouter.use(requiereAutenticacion);

const esquemaConfig = z.object({
  nombre: z.string().trim().min(3).max(120).default('Huawei SmartPVMS'),
  endpoint: z.string().trim().url('Ingrese una URL valida del API.').max(255),
  ip_autorizada: z.string().trim().max(64).optional().nullable(),
  usuario_api: z.string().trim().max(120).optional().nullable(),
  modo: z.enum(['MOCK', 'REAL']).default('MOCK'),
  estado: z.enum(['ACTIVA', 'INACTIVA', 'PENDIENTE_AUTORIZACION']).default('PENDIENTE_AUTORIZACION'),
  timeout_s: z.coerce.number().int().min(5).max(300).default(40),
  max_reintentos: z.coerce.number().int().min(0).max(10).default(3),
  sync_programada: z.boolean().default(false),
  sync_hora: z.string().regex(/^\d{2}:\d{2}$/, 'Use el formato HH:MM.').optional().nullable(),
});

const esquemaSync = z.object({
  id_api: z.coerce.number().int().positive(),
  id_proyecto: z.coerce.number().int().positive().optional().nullable(),
  id_inversor: z.coerce.number().int().positive().optional().nullable(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  granularidad: z.enum(['DIARIA', 'MENSUAL']).default('DIARIA'),
});

/**
 * Proyeccion segura de la configuracion: nunca se devuelve un secreto.
 * `secreto_ref` solo indica DONDE vive la credencial, no su valor.
 */
function proyectarConfig(fila: Record<string, unknown>) {
  return {
    ...fila,
    secreto_ref: fila.secreto_ref ?? null,
    credencialConfigurada: Boolean(process.env.HUAWEI_USERNAME && process.env.HUAWEI_SYSTEM_CODE),
    // Se muestran solo los ultimos caracteres del usuario, nunca la contrasena.
    usuario_api_enmascarado: fila.usuario_api
      ? `${String(fila.usuario_api).slice(0, 2)}${'*'.repeat(Math.max(0, String(fila.usuario_api).length - 4))}${String(fila.usuario_api).slice(-2)}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// GET /integrations/huawei/config
// ---------------------------------------------------------------------------
huaweiRouter.get(
  '/config',
  requierePermiso(PERMISOS.HUAWEI_VER),
  asyncHandler(async (_req, res) => {
    const filas = await query<Record<string, unknown>>(
      "SELECT * FROM apis_fabricante WHERE marca = 'HUAWEI' ORDER BY id_api",
    );
    ok(res, filas.map(proyectarConfig), {
      modoEntorno: env.huawei.mode,
      advertenciaMock:
        env.huawei.mode === 'MOCK'
          ? 'El sistema opera en modo SIMULADO. Los datos generados son ficticios y estan marcados como tales.'
          : null,
      pasosParaActivarReal: [
        'Crear una cuenta Northbound en el portal FusionSolar (Sistema > Gestion de la Empresa > Gestion Northbound).',
        'Definir HUAWEI_USERNAME y HUAWEI_SYSTEM_CODE como variables de entorno del servicio Python.',
        'Cambiar HUAWEI_MODE=real y el modo de la configuracion a REAL.',
        'Ejecutar "Probar conexion" antes de la primera sincronizacion.',
        'Solo si Huawei rechaza la conexion con el error "IP no autorizada": pedir al administrador de FusionSolar que autorice la IP publica de este servidor.',
      ],
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /integrations/huawei/config/:id
// ---------------------------------------------------------------------------
huaweiRouter.put(
  '/config/:id',
  requierePermiso(PERMISOS.HUAWEI_CONFIGURAR),
  validarCuerpo(esquemaConfig.partial()),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const datos = req.body as Partial<z.infer<typeof esquemaConfig>>;

    const actual = await queryOne('SELECT * FROM apis_fabricante WHERE id_api = ?', [id]);
    if (!actual) throw errores.noEncontrado('la configuracion de integracion');

    // NOTA: las guias vigentes de alta de una cuenta Northbound de FusionSolar
    // no piden registrar de antemano una IP publica autorizada, asi que ya
    // no se bloquea activar el modo REAL por no tenerla. El campo se deja
    // como dato opcional/informativo: solo importa si Huawei responde el
    // error 20008 (IP_NO_AUTORIZADA) para una cuenta en particular.

    const mapa: Record<string, unknown> = {
      nombre: datos.nombre,
      endpoint: datos.endpoint,
      ip_autorizada: datos.ip_autorizada,
      usuario_api: datos.usuario_api,
      modo: datos.modo,
      estado: datos.estado,
      timeout_s: datos.timeout_s,
      max_reintentos: datos.max_reintentos,
      sync_programada: datos.sync_programada === undefined ? undefined : datos.sync_programada ? 1 : 0,
      sync_hora: datos.sync_hora,
    };
    const campos = Object.entries(mapa).filter(([, v]) => v !== undefined);
    if (campos.length === 0) throw errores.solicitudInvalida('No se enviaron cambios.');

    await execute(
      `UPDATE apis_fabricante SET ${campos.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ?
        WHERE id_api = ?`,
      [...campos.map(([, v]) => v), req.usuario!.id_usuario, id],
    );

    await auditarDesdeRequest(req, {
      accion: 'INTEGRACION_CONFIGURADA',
      entidad: 'apis_fabricante',
      idEntidad: id,
      antes: actual,
      despues: datos,
    });

    ok(res, { mensaje: 'Configuracion de integracion actualizada.' });
  }),
);

// ---------------------------------------------------------------------------
// POST /integrations/huawei/test
// ---------------------------------------------------------------------------
huaweiRouter.post(
  '/test',
  requierePermiso(PERMISOS.HUAWEI_SINCRONIZAR),
  validarCuerpo(z.object({ id_api: z.coerce.number().int().positive() })),
  asyncHandler(async (req, res) => {
    const { id_api } = req.body as { id_api: number };
    const api = await queryOne<{
      endpoint: string;
      ip_autorizada: string | null;
      usuario_api: string | null;
      modo: 'MOCK' | 'REAL';
      timeout_s: number;
      max_reintentos: number;
    }>('SELECT * FROM apis_fabricante WHERE id_api = ?', [id_api]);
    if (!api) throw errores.noEncontrado('la configuracion de integracion');

    let resultado;
    let mensajeGuardado: string;
    try {
      resultado = await probarConexion({
        modo: api.modo,
        endpoint: api.endpoint,
        ip_autorizada: api.ip_autorizada,
        usuario_api: api.usuario_api,
        timeout_s: api.timeout_s,
        max_reintentos: api.max_reintentos,
      });
      mensajeGuardado = `OK (${resultado.modo}): ${resultado.mensaje}`;
    } catch (error) {
      mensajeGuardado = `ERROR: ${error instanceof Error ? error.message : 'desconocido'}`;
      await execute(
        'UPDATE apis_fabricante SET ultima_prueba = NOW(), resultado_ultima_prueba = ? WHERE id_api = ?',
        [mensajeGuardado.slice(0, 255), id_api],
      );
      await auditarDesdeRequest(req, {
        accion: 'INTEGRACION_PROBADA',
        entidad: 'apis_fabricante',
        idEntidad: id_api,
        resultado: 'FALLO',
        motivo: mensajeGuardado.slice(0, 400),
      });
      throw error;
    }

    await execute(
      'UPDATE apis_fabricante SET ultima_prueba = NOW(), resultado_ultima_prueba = ? WHERE id_api = ?',
      [mensajeGuardado.slice(0, 255), id_api],
    );

    await auditarDesdeRequest(req, {
      accion: 'INTEGRACION_PROBADA',
      entidad: 'apis_fabricante',
      idEntidad: id_api,
      despues: { modo: resultado.modo, mensaje: resultado.mensaje },
    });

    ok(res, resultado);
  }),
);

// ---------------------------------------------------------------------------
// POST /integrations/huawei/sync
// ---------------------------------------------------------------------------
huaweiRouter.post(
  '/sync',
  requierePermiso(PERMISOS.HUAWEI_SINCRONIZAR),
  validarCuerpo(esquemaSync),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaSync>;
    const resultado = await ejecutarSincronizacion({
      idApi: datos.id_api,
      idProyecto: datos.id_proyecto ?? null,
      idInversor: datos.id_inversor ?? null,
      desde: datos.desde,
      hasta: datos.hasta,
      granularidad: datos.granularidad,
      tipo: 'MANUAL',
      idUsuario: req.usuario!.id_usuario,
      emailUsuario: req.usuario!.email,
    });

    ok(res, {
      ...resultado,
      esSimulado: resultado.modo === 'MOCK',
      etiquetaOrigen:
        resultado.modo === 'MOCK'
          ? 'DATOS SIMULADOS (modo sandbox): no provienen de la plataforma real del fabricante.'
          : 'Datos obtenidos de Huawei SmartPVMS.',
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /integrations/huawei/runs
// ---------------------------------------------------------------------------
huaweiRouter.get(
  '/runs',
  requierePermiso(PERMISOS.HUAWEI_VER),
  validarConsulta(
    esquemaPaginacion.extend({
      estado: z.string().max(30).optional(),
      id_proyecto: z.coerce.number().int().positive().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquemaPaginacion> & { estado?: string; id_proyecto?: number }>(req);
    const { limite, desplazamiento } = limitesPaginacion(p);
    const condiciones = ['1 = 1'];
    const params: unknown[] = [];

    if (p.estado) {
      condiciones.push('s.estado = ?');
      params.push(p.estado);
    }
    if (p.id_proyecto) {
      condiciones.push('s.id_proyecto = ?');
      params.push(p.id_proyecto);
    }

    const donde = condiciones.join(' AND ');
    const filas = await query(
      `SELECT s.*, u.nombre AS usuario, pr.nombre AS proyecto,
              CONCAT(i.marca, ' ', i.modelo) AS inversor
         FROM sincronizaciones s
         LEFT JOIN usuarios u ON u.id_usuario = s.id_usuario
         LEFT JOIN proyectos pr ON pr.id_proyecto = s.id_proyecto
         LEFT JOIN inversores i ON i.id_inversor = s.id_inversor
        WHERE ${donde}
        ORDER BY s.iniciada_en DESC LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );
    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM sincronizaciones s WHERE ${donde}`,
      params,
    );
    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

huaweiRouter.get(
  '/runs/:id',
  requierePermiso(PERMISOS.HUAWEI_VER),
  asyncHandler(async (req, res) => {
    const fila = await queryOne(
      `SELECT s.*, u.nombre AS usuario FROM sincronizaciones s
         LEFT JOIN usuarios u ON u.id_usuario = s.id_usuario WHERE s.id_sync = ?`,
      [Number(req.params.id)],
    );
    if (!fila) throw errores.noEncontrado('la ejecucion de sincronizacion');
    ok(res, fila);
  }),
);

/** Rango sugerido para la sincronizacion (ultimos N dias configurables). */
huaweiRouter.get(
  '/suggested-range',
  requierePermiso(PERMISOS.HUAWEI_VER),
  asyncHandler(async (_req, res) => {
    const hoy = hoyISO();
    const desde = new Date(`${hoy}T00:00:00Z`);
    desde.setUTCDate(desde.getUTCDate() - 7);
    ok(res, { desde: desde.toISOString().slice(0, 10), hasta: hoy });
  }),
);
