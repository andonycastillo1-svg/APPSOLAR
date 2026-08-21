import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction } from '../../db/pool';
import { errores } from '../../utils/errors';
import { asyncHandler, consulta, creado, ok, validarConsulta, validarCuerpo } from '../../utils/http';
import { requierePermiso } from '../../middleware/autenticacion';
import { PERMISOS } from '../../config/permisos';
import { auditarDesdeRequest } from '../../services/auditoria';
import { MESES_ES, anioActual } from '../../utils/fechas';
import { porcentajeCumplimiento, redondear } from '../../utils/numeros';

/**
 * Submodulo de proyecciones mensuales de generacion (kWh).
 * Montado en `/api/projects/:projectId/projections`.
 *
 * La proyeccion es ENERGIA (kWh) y se mantiene separada de la tarifa (Q/kWh).
 */
export const proyeccionesRouter = Router({ mergeParams: true });

const esquemaMes = z.object({
  mes: z.coerce.number().int().min(1).max(12),
  proyeccion_kwh: z.coerce.number().min(0, 'La proyeccion no puede ser negativa.'),
  comentarios: z.string().trim().max(500).optional().nullable(),
});

const esquemaGuardar = z.object({
  // El anio SIEMPRE es explicito: nunca se adivina.
  anio: z.coerce.number().int().min(2000).max(2100),
  meses: z.array(esquemaMes).min(1, 'Envie al menos un mes.').max(12),
  aprobarInmediato: z.boolean().default(false),
});

const esquemaCopia = z.object({
  anioOrigen: z.coerce.number().int().min(2000).max(2100),
  anioDestino: z.coerce.number().int().min(2000).max(2100),
  factor: z.coerce.number().min(0).max(10).default(1),
  confirmado: z.literal(true, {
    errorMap: () => ({ message: 'Debe confirmar explicitamente la copia de proyecciones.' }),
  }),
});

async function proyectoDe(req: { params: Record<string, string> }): Promise<number> {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id <= 0) throw errores.solicitudInvalida('Proyecto invalido.');
  const existe = await queryOne('SELECT id_proyecto FROM proyectos WHERE id_proyecto = ?', [id]);
  if (!existe) throw errores.noEncontrado('el proyecto indicado');
  return id;
}

// ---------------------------------------------------------------------------
// GET /projects/:projectId/projections?anio=YYYY
// ---------------------------------------------------------------------------
proyeccionesRouter.get(
  '/',
  requierePermiso(PERMISOS.PROYECCIONES_VER),
  validarConsulta(z.object({ anio: z.coerce.number().int().min(2000).max(2100).optional() })),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const { anio = anioActual() } = consulta<{ anio?: number }>(req);

    const proyecciones = await query<{
      id_proyeccion: number;
      mes: number;
      proyeccion_kwh: number;
      estado: string;
      origen: string;
      comentarios: string | null;
      creado_por_nombre: string | null;
      aprobado_por_nombre: string | null;
      updated_at: string;
    }>(
      `SELECT pj.id_proyeccion, pj.mes, pj.proyeccion_kwh, pj.estado, pj.origen, pj.comentarios,
              uc.nombre AS creado_por_nombre, ua.nombre AS aprobado_por_nombre, pj.updated_at
         FROM proyecciones_kwh pj
         LEFT JOIN usuarios uc ON uc.id_usuario = pj.creado_por
         LEFT JOIN usuarios ua ON ua.id_usuario = pj.aprobado_por
        WHERE pj.id_proyecto = ? AND pj.anio = ? AND pj.estado <> 'ANULADA'
        ORDER BY pj.mes`,
      [idProyecto, anio],
    );

    const real = await query<{ mes: number; kwh: number }>(
      `SELECT mes, COALESCE(SUM(kwh), 0) AS kwh FROM produccion
        WHERE id_proyecto = ? AND anio = ? AND activo = 1 GROUP BY mes`,
      [idProyecto, anio],
    );

    const porMes = new Map(proyecciones.map((p) => [p.mes, p]));
    const realPorMes = new Map(real.map((r) => [r.mes, Number(r.kwh)]));

    const calendario = Array.from({ length: 12 }, (_, i) => {
      const mes = i + 1;
      const proyeccion = porMes.get(mes) ?? null;
      const generacion = realPorMes.get(mes) ?? 0;
      const base = proyeccion?.estado === 'APROBADA' ? Number(proyeccion.proyeccion_kwh) : null;
      return {
        mes,
        mesNombre: MESES_ES[i],
        proyeccion,
        generacion_kwh: redondear(generacion, 4),
        cumplimiento: porcentajeCumplimiento(generacion, base),
        // Se muestra "Sin proyeccion" en lugar de una division invalida.
        etiquetaCumplimiento: base === null ? 'Sin proyeccion' : null,
      };
    });

    const totalProyectado = calendario.reduce(
      (acc, m) => acc + (m.proyeccion?.estado === 'APROBADA' ? Number(m.proyeccion.proyeccion_kwh) : 0),
      0,
    );
    const totalReal = calendario.reduce((acc, m) => acc + m.generacion_kwh, 0);

    ok(res, {
      anio,
      id_proyecto: idProyecto,
      calendario,
      totales: {
        proyeccion_kwh: redondear(totalProyectado, 4),
        generacion_kwh: redondear(totalReal, 4),
        cumplimiento: porcentajeCumplimiento(totalReal, totalProyectado || null),
        mesesAprobados: calendario.filter((m) => m.proyeccion?.estado === 'APROBADA').length,
        mesesSinProyeccion: calendario.filter((m) => !m.proyeccion).length,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/projections  (captura manual del calendario)
// ---------------------------------------------------------------------------
proyeccionesRouter.post(
  '/',
  requierePermiso(PERMISOS.PROYECCIONES_GESTIONAR),
  validarCuerpo(esquemaGuardar),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const datos = req.body as z.infer<typeof esquemaGuardar>;

    if (datos.aprobarInmediato && !req.usuario!.permisos.includes(PERMISOS.PROYECCIONES_APROBAR)) {
      throw errores.sinPermiso(PERMISOS.PROYECCIONES_APROBAR);
    }

    const estado = datos.aprobarInmediato ? 'APROBADA' : 'BORRADOR';
    let insertadas = 0;
    let actualizadas = 0;

    await withTransaction(async (conn) => {
      for (const mes of datos.meses) {
        const existente = await queryOne<{ id_proyeccion: number; estado: string }>(
          `SELECT id_proyeccion, estado FROM proyecciones_kwh
            WHERE id_proyecto = ? AND anio = ? AND mes = ? AND estado <> 'ANULADA'`,
          [idProyecto, datos.anio, mes.mes],
          conn,
        );

        if (existente) {
          await execute(
            `UPDATE proyecciones_kwh
                SET proyeccion_kwh = ?, comentarios = ?, estado = ?,
                    aprobado_por = ?, fecha_aprobacion = ?, updated_by = ?
              WHERE id_proyeccion = ?`,
            [
              mes.proyeccion_kwh,
              mes.comentarios ?? null,
              estado,
              estado === 'APROBADA' ? req.usuario!.id_usuario : null,
              estado === 'APROBADA' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
              req.usuario!.id_usuario,
              existente.id_proyeccion,
            ],
            conn,
          );
          actualizadas += 1;
        } else {
          await execute(
            `INSERT INTO proyecciones_kwh
               (id_proyecto, anio, mes, proyeccion_kwh, estado, origen, comentarios,
                creado_por, aprobado_por, fecha_aprobacion)
             VALUES (?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?)`,
            [
              idProyecto,
              datos.anio,
              mes.mes,
              mes.proyeccion_kwh,
              estado,
              mes.comentarios ?? null,
              req.usuario!.id_usuario,
              estado === 'APROBADA' ? req.usuario!.id_usuario : null,
              estado === 'APROBADA' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
            ],
            conn,
          );
          insertadas += 1;
        }
      }
    });

    await auditarDesdeRequest(req, {
      accion: 'PROYECCION_REGISTRADA',
      entidad: 'proyecciones_kwh',
      idEntidad: `${idProyecto}-${datos.anio}`,
      despues: { anio: datos.anio, meses: datos.meses.length, estado },
    });

    creado(res, {
      insertadas,
      actualizadas,
      estado,
      mensaje: `Proyeccion guardada para ${datos.meses.length} mes(es) de ${datos.anio} en estado ${estado}.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/projections/copy-year
// ---------------------------------------------------------------------------
proyeccionesRouter.post(
  '/copy-year',
  requierePermiso(PERMISOS.PROYECCIONES_GESTIONAR),
  validarCuerpo(esquemaCopia),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const { anioOrigen, anioDestino, factor } = req.body as z.infer<typeof esquemaCopia>;

    if (anioOrigen === anioDestino) {
      throw errores.validacion('El anio de origen y el de destino deben ser diferentes.');
    }

    const origen = await query<{ mes: number; proyeccion_kwh: number }>(
      `SELECT mes, proyeccion_kwh FROM proyecciones_kwh
        WHERE id_proyecto = ? AND anio = ? AND estado <> 'ANULADA' ORDER BY mes`,
      [idProyecto, anioOrigen],
    );
    if (origen.length === 0) {
      throw errores.reglaNegocio(`El anio ${anioOrigen} no tiene proyecciones registradas.`);
    }

    let copiadas = 0;
    await withTransaction(async (conn) => {
      for (const fila of origen) {
        const existe = await queryOne(
          `SELECT id_proyeccion FROM proyecciones_kwh
            WHERE id_proyecto = ? AND anio = ? AND mes = ? AND estado <> 'ANULADA'`,
          [idProyecto, anioDestino, fila.mes],
          conn,
        );
        if (existe) continue;
        await execute(
          `INSERT INTO proyecciones_kwh
             (id_proyecto, anio, mes, proyeccion_kwh, estado, origen, comentarios, creado_por)
           VALUES (?, ?, ?, ?, 'BORRADOR', 'COPIA_ANIO', ?, ?)`,
          [
            idProyecto,
            anioDestino,
            fila.mes,
            redondear(Number(fila.proyeccion_kwh) * factor, 4),
            `Copiado de ${anioOrigen}${factor !== 1 ? ` con factor ${factor}` : ''}`,
            req.usuario!.id_usuario,
          ],
          conn,
        );
        copiadas += 1;
      }
    });

    await auditarDesdeRequest(req, {
      accion: 'PROYECCION_COPIADA',
      entidad: 'proyecciones_kwh',
      idEntidad: `${idProyecto}-${anioDestino}`,
      despues: { anioOrigen, anioDestino, factor, copiadas },
    });

    creado(res, {
      copiadas,
      omitidas: origen.length - copiadas,
      mensaje: `Se copiaron ${copiadas} mes(es) como BORRADOR. Revise y apruebe antes de usarlos en reportes.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/projections/:projectionId/approve
// ---------------------------------------------------------------------------
proyeccionesRouter.post(
  '/:projectionId/approve',
  requierePermiso(PERMISOS.PROYECCIONES_APROBAR),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const id = Number(req.params.projectionId);

    const proyeccion = await queryOne<{ estado: string; anio: number; mes: number }>(
      'SELECT * FROM proyecciones_kwh WHERE id_proyeccion = ? AND id_proyecto = ?',
      [id, idProyecto],
    );
    if (!proyeccion) throw errores.noEncontrado('la proyeccion indicada');
    if (proyeccion.estado === 'APROBADA') throw errores.conflicto('La proyeccion ya estaba aprobada.');

    await execute(
      `UPDATE proyecciones_kwh
          SET estado = 'APROBADA', aprobado_por = ?, fecha_aprobacion = NOW(), updated_by = ?
        WHERE id_proyeccion = ?`,
      [req.usuario!.id_usuario, req.usuario!.id_usuario, id],
    );

    await auditarDesdeRequest(req, {
      accion: 'PROYECCION_APROBADA',
      entidad: 'proyecciones_kwh',
      idEntidad: id,
      antes: proyeccion,
    });

    ok(res, {
      mensaje: `Proyeccion de ${MESES_ES[proyeccion.mes - 1]} ${proyeccion.anio} aprobada.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/projections/approve-year
// ---------------------------------------------------------------------------
proyeccionesRouter.post(
  '/approve-year',
  requierePermiso(PERMISOS.PROYECCIONES_APROBAR),
  validarCuerpo(z.object({ anio: z.coerce.number().int().min(2000).max(2100) })),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const { anio } = req.body as { anio: number };

    const resultado = await execute(
      `UPDATE proyecciones_kwh
          SET estado = 'APROBADA', aprobado_por = ?, fecha_aprobacion = NOW(), updated_by = ?
        WHERE id_proyecto = ? AND anio = ? AND estado = 'BORRADOR'`,
      [req.usuario!.id_usuario, req.usuario!.id_usuario, idProyecto, anio],
    );

    await auditarDesdeRequest(req, {
      accion: 'PROYECCION_APROBADA_ANUAL',
      entidad: 'proyecciones_kwh',
      idEntidad: `${idProyecto}-${anio}`,
      despues: { aprobadas: resultado.affectedRows },
    });

    ok(res, {
      aprobadas: resultado.affectedRows,
      mensaje: `Se aprobaron ${resultado.affectedRows} proyeccion(es) del anio ${anio}.`,
    });
  }),
);
