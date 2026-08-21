import { Router } from 'express';
import os from 'node:os';
import { z } from 'zod';
import { env } from '../../config/env';
import { query, queryOne, ping } from '../../db/pool';
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
import { actualizarParametro, listarConfiguracion } from '../../services/configuracion';
import { saludServicio } from '../../services/huaweiCliente';
import { ahoraLocal, ZONA_HORARIA } from '../../utils/fechas';

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
export const auditoriaRouter = Router();
auditoriaRouter.use(requiereAutenticacion);

auditoriaRouter.get(
  '/',
  requierePermiso(PERMISOS.AUDITORIA_VER),
  validarConsulta(
    esquemaPaginacion.extend({
      accion: z.string().max(80).optional(),
      entidad: z.string().max(60).optional(),
      id_usuario: z.coerce.number().int().positive().optional(),
      desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      resultado: z.enum(['EXITO', 'FALLO']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<
      z.infer<typeof esquemaPaginacion> & {
        accion?: string;
        entidad?: string;
        id_usuario?: number;
        desde?: string;
        hasta?: string;
        resultado?: string;
      }
    >(req);
    const { limite, desplazamiento } = limitesPaginacion(p);

    const condiciones = ['1 = 1'];
    const params: unknown[] = [];

    if (p.accion) {
      condiciones.push('a.accion = ?');
      params.push(p.accion);
    }
    if (p.entidad) {
      condiciones.push('a.entidad = ?');
      params.push(p.entidad);
    }
    if (p.id_usuario) {
      condiciones.push('a.id_usuario = ?');
      params.push(p.id_usuario);
    }
    if (p.resultado) {
      condiciones.push('a.resultado = ?');
      params.push(p.resultado);
    }
    if (p.desde) {
      condiciones.push('a.created_at >= ?');
      params.push(`${p.desde} 00:00:00`);
    }
    if (p.hasta) {
      condiciones.push('a.created_at <= ?');
      params.push(`${p.hasta} 23:59:59`);
    }
    if (p.buscar) {
      condiciones.push('(a.usuario_email LIKE ? OR a.motivo LIKE ? OR a.id_entidad LIKE ?)');
      params.push(`%${p.buscar}%`, `%${p.buscar}%`, `%${p.buscar}%`);
    }

    const donde = condiciones.join(' AND ');
    const filas = await query(
      `SELECT a.*, u.nombre AS usuario_nombre FROM auditoria a
         LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
        WHERE ${donde} ORDER BY a.created_at DESC, a.id_auditoria DESC LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );
    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM auditoria a WHERE ${donde}`,
      params,
    );
    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

auditoriaRouter.get(
  '/acciones',
  requierePermiso(PERMISOS.AUDITORIA_VER),
  asyncHandler(async (_req, res) => {
    const acciones = await query('SELECT DISTINCT accion FROM auditoria ORDER BY accion');
    const entidades = await query('SELECT DISTINCT entidad FROM auditoria ORDER BY entidad');
    ok(res, { acciones, entidades });
  }),
);

// ---------------------------------------------------------------------------
// Configuracion
// ---------------------------------------------------------------------------
export const configuracionRouter = Router();
configuracionRouter.use(requiereAutenticacion);

configuracionRouter.get(
  '/',
  requierePermiso(PERMISOS.CONFIG_VER),
  asyncHandler(async (_req, res) => {
    ok(res, await listarConfiguracion());
  }),
);

configuracionRouter.put(
  '/:clave',
  requierePermiso(PERMISOS.CONFIG_GESTIONAR),
  validarCuerpo(z.object({ valor: z.string().max(500) })),
  asyncHandler(async (req, res) => {
    const clave = String(req.params.clave);
    const { valor } = req.body as { valor: string };

    const actual = await queryOne<{ valor: string; tipo: string; editable: number }>(
      'SELECT valor, tipo, editable FROM configuracion WHERE clave = ?',
      [clave],
    );
    if (!actual) throw errores.noEncontrado('el parametro de configuracion');
    if (!actual.editable) {
      throw errores.reglaNegocio('Este parametro es fijo del sistema y no puede modificarse.');
    }

    if (actual.tipo === 'NUMERO' && !Number.isFinite(Number(valor))) {
      throw errores.validacion('El parametro requiere un valor numerico.');
    }
    if (actual.tipo === 'BOOLEANO' && !['true', 'false'].includes(valor.toLowerCase())) {
      throw errores.validacion('El parametro requiere el valor "true" o "false".');
    }

    await actualizarParametro(clave, valor, req.usuario!.id_usuario);
    await auditarDesdeRequest(req, {
      accion: 'CONFIGURACION_ACTUALIZADA',
      entidad: 'configuracion',
      idEntidad: clave,
      antes: { valor: actual.valor },
      despues: { valor },
    });

    ok(res, { mensaje: 'Parametro actualizado correctamente.' });
  }),
);

// ---------------------------------------------------------------------------
// Salud del sistema
// ---------------------------------------------------------------------------
export const saludRouter = Router();

/** Version publica minima: no revela detalles internos. */
saludRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const baseDatos = await ping();
    res.status(baseDatos ? 200 : 503).json({
      ok: baseDatos,
      datos: {
        estado: baseDatos ? 'operativo' : 'degradado',
        servicio: env.appName,
        hora: new Date().toISOString(),
      },
    });
  }),
);

/** Detalle protegido para administradores. */
saludRouter.get(
  '/detalle',
  requiereAutenticacion,
  requierePermiso(PERMISOS.SALUD_VER),
  asyncHandler(async (_req, res) => {
    const baseDatos = await ping();
    const python = await saludServicio();

    const [tamano, ultimaTarea, ultimaSync, ultimaImportacion] = await Promise.all([
      queryOne<{ tablas: number; mb: number }>(
        `SELECT COUNT(*) AS tablas, ROUND(SUM(data_length + index_length) / 1048576, 2) AS mb
           FROM information_schema.tables WHERE table_schema = ?`,
        [env.db.database],
      ),
      queryOne<{ ultima: string | null }>(
        "SELECT MAX(iniciada_en) AS ultima FROM sincronizaciones WHERE tipo = 'PROGRAMADA'",
      ),
      queryOne('SELECT id_sync, estado, modo, iniciada_en, mensaje FROM sincronizaciones ORDER BY iniciada_en DESC LIMIT 1'),
      queryOne('SELECT id_historico, estado, created_at FROM historicos ORDER BY created_at DESC LIMIT 1'),
    ]);

    res.status(baseDatos ? 200 : 503).json({
      ok: baseDatos && python.ok,
      datos: {
        api: {
          estado: 'operativo',
          version: '1.0.0',
          entorno: env.nodeEnv,
          uptimeSegundos: Math.round(process.uptime()),
          memoriaMb: Math.round(process.memoryUsage().rss / 1048576),
          nodo: process.version,
          host: os.hostname(),
        },
        mysql: {
          estado: baseDatos ? 'operativo' : 'no disponible',
          base: env.db.database,
          tablas: tamano?.tablas ?? 0,
          tamanoMb: tamano?.mb ?? 0,
        },
        servicioPython: {
          estado: python.ok ? 'operativo' : 'no disponible',
          url: env.python.url,
          version: python.version ?? null,
          modo: python.modo ?? env.huawei.mode,
        },
        integracionHuawei: {
          modo: env.huawei.mode,
          simulado: env.huawei.mode === 'MOCK',
          ipAutorizada: env.huawei.authorizedIp || 'no configurada',
        },
        tareaProgramada: {
          habilitada: env.sync.cronEnabled,
          horario: `${String(env.sync.hour).padStart(2, '0')}:${String(env.sync.minute).padStart(2, '0')}`,
          ultimaEjecucion: ultimaTarea?.ultima ?? null,
        },
        ultimaSincronizacion: ultimaSync,
        ultimaImportacion,
        zonaHoraria: ZONA_HORARIA,
        horaLocal: ahoraLocal(),
      },
    });
  }),
);
