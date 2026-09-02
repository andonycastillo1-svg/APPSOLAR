import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction } from '../../db/pool';
import { errores } from '../../utils/errors';
import { asyncHandler, consulta, creado, ok, validarConsulta, validarCuerpo } from '../../utils/http';
import { requierePermiso, tienePermiso } from '../../middleware/autenticacion';
import { PERMISOS } from '../../config/permisos';
import { auditarDesdeRequest } from '../../services/auditoria';
import {
  alertaTarifaTrimestral,
  analizarImpacto,
  exigirMesAbierto,
  exigirTrimestreAbierto,
  mesesCerradosDelTrimestre,
  recalcularPendientes,
  recalcularPorTarifa,
} from '../../services/valorizacion';
import { obtenerNumero } from '../../services/configuracion';
import {
  MESES_ES,
  TRIMESTRES,
  anioActual,
  etiquetaTrimestre,
  mesesDelTrimestre,
  nombreMesesTrimestre,
  trimestreSiguiente,
} from '../../utils/fechas';

/**
 * Submodulo "Tarifas de energia" de cada proyecto.
 *
 * La tarifa del kWh tiene vigencia TRIMESTRAL sobre trimestres calendario
 * (Ene-Mar, Abr-Jun, Jul-Sep, Oct-Dic) y debe actualizarse cada trimestre.
 * El sistema avisa cuando el trimestre en curso no tiene tarifa aprobada y
 * cuando se acerca el cambio de trimestre sin la siguiente registrada.
 *
 * Montado en `/api/projects/:projectId/rates` (requiere `mergeParams`).
 */
export const tarifasRouter = Router({ mergeParams: true });

const esquemaCrear = z.object({
  anio: z.coerce.number().int().min(2000).max(2100),
  trimestre: z.coerce.number().int().min(1, 'El trimestre va de 1 a 4.').max(4),
  costo_kwh: z.coerce.number().min(0, 'El costo del kWh no puede ser negativo.'),
  moneda: z.literal('GTQ').default('GTQ'),
  motivo: z.string().trim().max(500).optional().nullable(),
  aprobarInmediato: z.boolean().default(false),
});

const esquemaCopia = z.object({
  anio: z.coerce.number().int().min(2000).max(2100),
  trimestre: z.coerce.number().int().min(1).max(4),
  confirmado: z.literal(true, {
    errorMap: () => ({
      message: 'Debe confirmar explicitamente la copia de la tarifa del trimestre anterior.',
    }),
  }),
});

const esquemaImpacto = z.object({
  costo_kwh: z.coerce.number().min(0, 'El costo del kWh no puede ser negativo.'),
});

const esquemaRecalculo = z.object({
  costo_kwh: z.coerce.number().min(0, 'El costo del kWh no puede ser negativo.'),
  motivo: z.string().trim().min(10, 'Describa el motivo de la correccion (minimo 10 caracteres).').max(500),
  confirmado: z.literal(true, {
    errorMap: () => ({ message: 'Debe confirmar el recalculo tras revisar el impacto.' }),
  }),
});

const esquemaCierre = z.object({
  anio: z.coerce.number().int().min(2000).max(2100),
  mes: z.coerce.number().int().min(1).max(12),
  motivo: z.string().trim().max(500).optional(),
});

const esquemaReapertura = esquemaCierre.extend({
  motivo: z.string().trim().min(10, 'Indique el motivo de la reapertura (minimo 10 caracteres).').max(500),
});

async function proyectoDe(req: { params: Record<string, string> }): Promise<number> {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id <= 0) throw errores.solicitudInvalida('Proyecto invalido.');
  const existe = await queryOne('SELECT id_proyecto FROM proyectos WHERE id_proyecto = ?', [id]);
  if (!existe) throw errores.noEncontrado('el proyecto indicado');
  return id;
}

// ---------------------------------------------------------------------------
// GET /projects/:projectId/rates?anio=YYYY  -> calendario anual de 4 trimestres
// ---------------------------------------------------------------------------
tarifasRouter.get(
  '/',
  requierePermiso(PERMISOS.TARIFAS_VER),
  validarConsulta(z.object({ anio: z.coerce.number().int().min(2000).max(2100).optional() })),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const { anio = anioActual() } = consulta<{ anio?: number }>(req);

    const tarifas = await query<{
      id_tarifa: number;
      trimestre: number;
      costo_kwh: number;
      moneda: string;
      estado: string;
      origen: string;
      creado_por_nombre: string | null;
      aprobado_por_nombre: string | null;
      fecha_creacion: string;
      fecha_aprobacion: string | null;
      updated_at: string;
    }>(
      `SELECT t.id_tarifa, t.trimestre, t.costo_kwh, t.moneda, t.estado, t.origen,
              uc.nombre AS creado_por_nombre, ua.nombre AS aprobado_por_nombre,
              t.fecha_creacion, t.fecha_aprobacion, t.updated_at
         FROM tarifas_kwh t
         LEFT JOIN usuarios uc ON uc.id_usuario = t.creado_por
         LEFT JOIN usuarios ua ON ua.id_usuario = t.aprobado_por
        WHERE t.id_proyecto = ? AND t.anio = ? AND t.estado <> 'ANULADA'
        ORDER BY t.trimestre`,
      [idProyecto, anio],
    );

    const cierres = await query<{ mes: number; estado: string }>(
      'SELECT mes, estado FROM cierres_mensuales WHERE id_proyecto = ? AND anio = ?',
      [idProyecto, anio],
    );

    // La produccion se agrega por trimestre para saber que periodos tienen
    // energia registrada sin tarifa aprobada.
    const produccion = await query<{
      trimestre: number;
      registros: number;
      pendientes: number;
      kwh: number;
    }>(
      `SELECT CEIL(mes / 3) AS trimestre, COUNT(*) AS registros,
              SUM(estado_valorizacion = 'PENDIENTE_DE_TARIFA') AS pendientes,
              COALESCE(SUM(kwh), 0) AS kwh
         FROM produccion WHERE id_proyecto = ? AND anio = ? AND activo = 1
        GROUP BY CEIL(mes / 3)`,
      [idProyecto, anio],
    );

    const porTrimestre = new Map(tarifas.map((t) => [t.trimestre, t]));
    const prodPorTrimestre = new Map(produccion.map((p) => [Number(p.trimestre), p]));
    const cerradosPorMes = new Set(
      cierres.filter((c) => c.estado === 'CERRADO').map((c) => c.mes),
    );

    const calendario = TRIMESTRES.map((definicion) => {
      const trimestre = definicion.numero;
      const tarifa = porTrimestre.get(trimestre) ?? null;
      const prod = prodPorTrimestre.get(trimestre);
      const meses = mesesDelTrimestre(trimestre);
      const mesesCerrados = meses.filter((m) => cerradosPorMes.has(m));

      return {
        trimestre,
        etiqueta: definicion.etiqueta,
        meses: definicion.meses,
        mesesNumeros: meses,
        mesesNombres: meses.map((m) => MESES_ES[m - 1]),
        tarifa,
        mesesCerrados,
        cerradoParcial: mesesCerrados.length > 0 && mesesCerrados.length < 3,
        cerradoCompleto: mesesCerrados.length === 3,
        registrosProduccion: Number(prod?.registros ?? 0),
        registrosPendientes: Number(prod?.pendientes ?? 0),
        kwh: Number(prod?.kwh ?? 0),
        requiereAtencion: Number(prod?.registros ?? 0) > 0 && tarifa?.estado !== 'APROBADA',
      };
    });

    const diasDeAviso = await obtenerNumero('tarifa.dias_aviso_trimestre', 15);
    const alerta = await alertaTarifaTrimestral(diasDeAviso, idProyecto);

    ok(res, {
      anio,
      id_proyecto: idProyecto,
      periodicidad: 'TRIMESTRAL',
      calendario,
      alerta,
      resumen: {
        trimestresAprobados: calendario.filter((t) => t.tarifa?.estado === 'APROBADA').length,
        trimestresBorrador: calendario.filter((t) => t.tarifa?.estado === 'BORRADOR').length,
        trimestresSinTarifa: calendario.filter((t) => !t.tarifa).length,
        trimestresConProduccionSinTarifa: calendario.filter((t) => t.requiereAtencion).length,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /projects/:projectId/rates/alert   Alerta de actualizacion trimestral
// ---------------------------------------------------------------------------
tarifasRouter.get(
  '/alert',
  requierePermiso(PERMISOS.TARIFAS_VER),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const diasDeAviso = await obtenerNumero('tarifa.dias_aviso_trimestre', 15);
    ok(res, await alertaTarifaTrimestral(diasDeAviso, idProyecto));
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/rates
// ---------------------------------------------------------------------------
tarifasRouter.post(
  '/',
  requierePermiso(PERMISOS.TARIFAS_GESTIONAR),
  validarCuerpo(esquemaCrear),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const datos = req.body as z.infer<typeof esquemaCrear>;

    await exigirTrimestreAbierto(idProyecto, datos.anio, datos.trimestre);

    const vigente = await queryOne<{ id_tarifa: number; estado: string }>(
      `SELECT id_tarifa, estado FROM tarifas_kwh
        WHERE id_proyecto = ? AND anio = ? AND trimestre = ? AND estado <> 'ANULADA'`,
      [idProyecto, datos.anio, datos.trimestre],
    );
    if (vigente) {
      throw errores.conflicto(
        `Ya existe una tarifa ${vigente.estado.toLowerCase()} para el ` +
          `${etiquetaTrimestre(datos.anio, datos.trimestre)}. Editela o anulela antes de registrar una nueva.`,
        { id_tarifa: vigente.id_tarifa },
      );
    }

    // Aprobar en el mismo acto requiere el permiso especifico de aprobacion.
    const apruebaAhora = datos.aprobarInmediato && tienePermiso(req, PERMISOS.TARIFAS_APROBAR);
    if (datos.aprobarInmediato && !apruebaAhora) {
      throw errores.sinPermiso(PERMISOS.TARIFAS_APROBAR);
    }

    const resultado = await execute(
      `INSERT INTO tarifas_kwh
         (id_proyecto, anio, trimestre, mes, costo_kwh, moneda, estado, origen, motivo,
          creado_por, aprobado_por, fecha_aprobacion)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'MANUAL', ?, ?, ?, ?)`,
      [
        idProyecto,
        datos.anio,
        datos.trimestre,
        datos.costo_kwh,
        datos.moneda,
        apruebaAhora ? 'APROBADA' : 'BORRADOR',
        datos.motivo || null,
        req.usuario!.id_usuario,
        apruebaAhora ? req.usuario!.id_usuario : null,
        apruebaAhora ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      ],
    );

    let valorizacion = { registros: 0, kwh: 0, valor: 0 };
    if (apruebaAhora) {
      valorizacion = await recalcularPendientes(idProyecto, datos.anio, datos.trimestre);
    }

    await auditarDesdeRequest(req, {
      accion: apruebaAhora ? 'TARIFA_CREADA_Y_APROBADA' : 'TARIFA_CREADA',
      entidad: 'tarifas_kwh',
      idEntidad: resultado.insertId,
      despues: { ...datos, id_proyecto: idProyecto },
      motivo: datos.motivo ?? null,
    });

    creado(res, {
      id_tarifa: resultado.insertId,
      estado: apruebaAhora ? 'APROBADA' : 'BORRADOR',
      etiqueta: etiquetaTrimestre(datos.anio, datos.trimestre),
      valorizacion,
      mensaje: apruebaAhora
        ? `Tarifa del ${etiquetaTrimestre(datos.anio, datos.trimestre)} aprobada. ` +
          `Se valorizaron ${valorizacion.registros} registro(s) que estaban pendientes.`
        : `Tarifa del ${etiquetaTrimestre(datos.anio, datos.trimestre)} registrada en BORRADOR. ` +
          'Debe aprobarse para usarse en reportes oficiales.',
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/rates/copy-previous
// ---------------------------------------------------------------------------
tarifasRouter.post(
  '/copy-previous',
  requierePermiso(PERMISOS.TARIFAS_GESTIONAR),
  validarCuerpo(esquemaCopia),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const { anio, trimestre } = req.body as z.infer<typeof esquemaCopia>;
    await exigirTrimestreAbierto(idProyecto, anio, trimestre);

    const anioAnterior = trimestre === 1 ? anio - 1 : anio;
    const trimestreAnterior = trimestre === 1 ? 4 : trimestre - 1;

    const anterior = await queryOne<{ costo_kwh: number; moneda: string }>(
      `SELECT costo_kwh, moneda FROM tarifas_kwh
        WHERE id_proyecto = ? AND anio = ? AND trimestre = ? AND estado = 'APROBADA'`,
      [idProyecto, anioAnterior, trimestreAnterior],
    );
    if (!anterior) {
      throw errores.reglaNegocio(
        `No existe una tarifa aprobada para el ${etiquetaTrimestre(anioAnterior, trimestreAnterior)}, ` +
          'por lo que no hay nada que copiar.',
      );
    }

    const vigente = await queryOne(
      `SELECT id_tarifa FROM tarifas_kwh
        WHERE id_proyecto = ? AND anio = ? AND trimestre = ? AND estado <> 'ANULADA'`,
      [idProyecto, anio, trimestre],
    );
    if (vigente) throw errores.conflicto('El trimestre destino ya tiene una tarifa registrada.');

    const resultado = await execute(
      `INSERT INTO tarifas_kwh
         (id_proyecto, anio, trimestre, mes, costo_kwh, moneda, estado, origen, motivo, creado_por)
       VALUES (?, ?, ?, NULL, ?, ?, 'BORRADOR', 'COPIA_MES_ANTERIOR', ?, ?)`,
      [
        idProyecto,
        anio,
        trimestre,
        anterior.costo_kwh,
        anterior.moneda,
        `Copia confirmada del ${etiquetaTrimestre(anioAnterior, trimestreAnterior)}`,
        req.usuario!.id_usuario,
      ],
    );

    await auditarDesdeRequest(req, {
      accion: 'TARIFA_COPIADA',
      entidad: 'tarifas_kwh',
      idEntidad: resultado.insertId,
      despues: { id_proyecto: idProyecto, anio, trimestre, costo_kwh: anterior.costo_kwh },
    });

    creado(res, {
      id_tarifa: resultado.insertId,
      costo_kwh: anterior.costo_kwh,
      mensaje:
        'Se creo un BORRADOR con la tarifa del trimestre anterior. Revisela y apruebela para que tenga efecto.',
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /projects/:projectId/rates/:rateId  (solo BORRADOR)
// ---------------------------------------------------------------------------
tarifasRouter.put(
  '/:rateId',
  requierePermiso(PERMISOS.TARIFAS_GESTIONAR),
  validarCuerpo(z.object({ costo_kwh: z.coerce.number().min(0), motivo: z.string().trim().max(500).optional() })),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idTarifa = Number(req.params.rateId);
    const datos = req.body as { costo_kwh: number; motivo?: string };

    const tarifa = await queryOne<{
      id_tarifa: number;
      estado: string;
      anio: number;
      trimestre: number;
      costo_kwh: number;
    }>('SELECT * FROM tarifas_kwh WHERE id_tarifa = ? AND id_proyecto = ?', [idTarifa, idProyecto]);
    if (!tarifa) throw errores.noEncontrado('la tarifa indicada');

    if (tarifa.estado !== 'BORRADOR') {
      throw errores.reglaNegocio(
        'Solo se puede editar directamente una tarifa en BORRADOR. Una tarifa aprobada requiere el flujo de correccion con analisis de impacto.',
        { usar: `POST /api/projects/${idProyecto}/rates/${idTarifa}/recalculate` },
      );
    }
    await exigirTrimestreAbierto(idProyecto, tarifa.anio, tarifa.trimestre);

    await execute(
      'UPDATE tarifas_kwh SET costo_kwh = ?, motivo = ?, updated_by = ? WHERE id_tarifa = ?',
      [datos.costo_kwh, datos.motivo ?? null, req.usuario!.id_usuario, idTarifa],
    );

    await auditarDesdeRequest(req, {
      accion: 'TARIFA_EDITADA',
      entidad: 'tarifas_kwh',
      idEntidad: idTarifa,
      antes: { costo_kwh: tarifa.costo_kwh },
      despues: { costo_kwh: datos.costo_kwh },
      motivo: datos.motivo ?? null,
    });

    ok(res, { mensaje: 'Tarifa actualizada.' });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/rates/:rateId/approve
// ---------------------------------------------------------------------------
tarifasRouter.post(
  '/:rateId/approve',
  requierePermiso(PERMISOS.TARIFAS_APROBAR),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idTarifa = Number(req.params.rateId);

    const tarifa = await queryOne<{ estado: string; anio: number; trimestre: number; costo_kwh: number }>(
      'SELECT * FROM tarifas_kwh WHERE id_tarifa = ? AND id_proyecto = ?',
      [idTarifa, idProyecto],
    );
    if (!tarifa) throw errores.noEncontrado('la tarifa indicada');
    if (tarifa.estado === 'APROBADA') throw errores.conflicto('La tarifa ya estaba aprobada.');
    if (tarifa.estado === 'ANULADA') {
      throw errores.reglaNegocio('Una tarifa anulada no puede aprobarse. Registre una nueva.');
    }
    await exigirTrimestreAbierto(idProyecto, tarifa.anio, tarifa.trimestre);

    const resultado = await withTransaction(async (conn) => {
      await execute(
        `UPDATE tarifas_kwh
            SET estado = 'APROBADA', aprobado_por = ?, fecha_aprobacion = NOW(), updated_by = ?
          WHERE id_tarifa = ?`,
        [req.usuario!.id_usuario, req.usuario!.id_usuario, idTarifa],
        conn,
      );
      // Solo se valorizan los registros PENDIENTES de ese proyecto y trimestre.
      return recalcularPendientes(idProyecto, tarifa.anio, tarifa.trimestre, conn);
    });

    await auditarDesdeRequest(req, {
      accion: 'TARIFA_APROBADA',
      entidad: 'tarifas_kwh',
      idEntidad: idTarifa,
      despues: { ...tarifa, estado: 'APROBADA', valorizacion: resultado },
    });

    ok(res, {
      valorizacion: resultado,
      etiqueta: etiquetaTrimestre(tarifa.anio, tarifa.trimestre),
      mensaje:
        `Tarifa del ${etiquetaTrimestre(tarifa.anio, tarifa.trimestre)} aprobada. ` +
        `Se valorizaron ${resultado.registros} registro(s) pendientes por Q ${resultado.valor.toFixed(2)}.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/rates/:rateId/impact  (analisis previo)
// ---------------------------------------------------------------------------
tarifasRouter.post(
  '/:rateId/impact',
  requierePermiso(PERMISOS.TARIFAS_RECALCULAR),
  validarCuerpo(esquemaImpacto),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idTarifa = Number(req.params.rateId);
    const { costo_kwh } = req.body as z.infer<typeof esquemaImpacto>;

    const pertenece = await queryOne('SELECT id_tarifa FROM tarifas_kwh WHERE id_tarifa = ? AND id_proyecto = ?', [
      idTarifa,
      idProyecto,
    ]);
    if (!pertenece) throw errores.noEncontrado('la tarifa indicada');

    const impacto = await analizarImpacto(idTarifa, costo_kwh);
    ok(res, {
      ...impacto,
      advertencia:
        impacto.mesesCerrados.length > 0
          ? `El trimestre tiene ${impacto.mesesCerrados.length} mes(es) CERRADO(s). Deben reabrirse con motivo antes de aplicar la correccion.`
          : impacto.registrosAfectados > 0
            ? `Esta correccion modificara ${impacto.registrosAfectados} registro(s) historicos de los tres meses del trimestre. Revise el impacto antes de confirmar.`
            : 'No existen registros valorizados con esta tarifa; la correccion no altera historicos.',
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/rates/:rateId/recalculate
// ---------------------------------------------------------------------------
tarifasRouter.post(
  '/:rateId/recalculate',
  requierePermiso(PERMISOS.TARIFAS_RECALCULAR),
  validarCuerpo(esquemaRecalculo),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idTarifa = Number(req.params.rateId);
    const datos = req.body as z.infer<typeof esquemaRecalculo>;

    const tarifa = await queryOne<{ estado: string; anio: number; trimestre: number; costo_kwh: number }>(
      'SELECT * FROM tarifas_kwh WHERE id_tarifa = ? AND id_proyecto = ?',
      [idTarifa, idProyecto],
    );
    if (!tarifa) throw errores.noEncontrado('la tarifa indicada');
    if (tarifa.estado !== 'APROBADA') {
      throw errores.reglaNegocio('Solo se recalculan tarifas aprobadas. Edite el borrador directamente.');
    }

    const cerrados = await mesesCerradosDelTrimestre(idProyecto, tarifa.anio, tarifa.trimestre);
    if (cerrados.length > 0) {
      throw errores.reglaNegocio(
        `El ${etiquetaTrimestre(tarifa.anio, tarifa.trimestre)} tiene meses cerrados ` +
          `(${cerrados.map((m) => MESES_ES[m - 1]).join(', ')}). Solicite su reapertura antes de corregir la tarifa.`,
        { mesesCerrados: cerrados },
      );
    }

    const impactoPrevio = await analizarImpacto(idTarifa, datos.costo_kwh);

    const resultado = await withTransaction(async (conn) => {
      await execute(
        'UPDATE tarifas_kwh SET costo_kwh = ?, motivo = ?, updated_by = ? WHERE id_tarifa = ?',
        [datos.costo_kwh, datos.motivo, req.usuario!.id_usuario, idTarifa],
        conn,
      );
      return recalcularPorTarifa(idTarifa, datos.costo_kwh, conn);
    });

    await auditarDesdeRequest(req, {
      accion: 'TARIFA_RECALCULADA',
      entidad: 'tarifas_kwh',
      idEntidad: idTarifa,
      antes: { costo_kwh: tarifa.costo_kwh, valorTotal: impactoPrevio.valorAnterior },
      despues: { costo_kwh: datos.costo_kwh, valorTotal: resultado.valorNuevo, registros: resultado.registros },
      motivo: datos.motivo,
    });

    ok(res, {
      ...resultado,
      etiqueta: etiquetaTrimestre(tarifa.anio, tarifa.trimestre),
      mensaje:
        `Tarifa del ${etiquetaTrimestre(tarifa.anio, tarifa.trimestre)} corregida. ` +
        `Se recalcularon ${resultado.registros} registro(s): Q ${resultado.valorAnterior.toFixed(2)} -> Q ${resultado.valorNuevo.toFixed(2)}.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/rates/:rateId/annul
// ---------------------------------------------------------------------------
tarifasRouter.post(
  '/:rateId/annul',
  requierePermiso(PERMISOS.TARIFAS_APROBAR),
  validarCuerpo(z.object({ motivo: z.string().trim().min(10, 'Indique el motivo de la anulacion.').max(500) })),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idTarifa = Number(req.params.rateId);
    const { motivo } = req.body as { motivo: string };

    const tarifa = await queryOne<{ estado: string; anio: number; trimestre: number }>(
      'SELECT * FROM tarifas_kwh WHERE id_tarifa = ? AND id_proyecto = ?',
      [idTarifa, idProyecto],
    );
    if (!tarifa) throw errores.noEncontrado('la tarifa indicada');
    if (tarifa.estado === 'ANULADA') throw errores.conflicto('La tarifa ya estaba anulada.');
    await exigirTrimestreAbierto(idProyecto, tarifa.anio, tarifa.trimestre);

    const usados = await queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM produccion WHERE id_tarifa = ? AND activo = 1',
      [idTarifa],
    );

    await withTransaction(async (conn) => {
      await execute(
        `UPDATE tarifas_kwh
            SET estado = 'ANULADA', anulado_por = ?, fecha_anulacion = NOW(), motivo = ?
          WHERE id_tarifa = ?`,
        [req.usuario!.id_usuario, motivo, idTarifa],
        conn,
      );
      // Los kWh se conservan; la valorizacion vuelve a quedar pendiente.
      await execute(
        `UPDATE produccion
            SET id_tarifa = NULL, costo_kwh_aplicado = NULL, valor_q = NULL,
                estado_valorizacion = 'PENDIENTE_DE_TARIFA'
          WHERE id_tarifa = ?`,
        [idTarifa],
        conn,
      );
    });

    await auditarDesdeRequest(req, {
      accion: 'TARIFA_ANULADA',
      entidad: 'tarifas_kwh',
      idEntidad: idTarifa,
      antes: tarifa,
      motivo,
    });

    ok(res, {
      registrosDesvalorizados: usados?.total ?? 0,
      mensaje: `Tarifa anulada. ${usados?.total ?? 0} registro(s) quedaron pendientes de tarifa; sus kWh se conservan intactos.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// Cierre y reapertura de periodos mensuales
//
// El cierre sigue siendo MENSUAL: la produccion y la proyeccion son mensuales
// y solo la tarifa cambio de periodicidad.
// ---------------------------------------------------------------------------
tarifasRouter.post(
  '/close',
  requierePermiso(PERMISOS.TARIFAS_CERRAR_MES),
  validarCuerpo(esquemaCierre),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const { anio, mes, motivo } = req.body as z.infer<typeof esquemaCierre>;

    const pendientes = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM produccion
        WHERE id_proyecto = ? AND anio = ? AND mes = ? AND activo = 1
          AND estado_valorizacion = 'PENDIENTE_DE_TARIFA'`,
      [idProyecto, anio, mes],
    );
    if ((pendientes?.total ?? 0) > 0) {
      throw errores.reglaNegocio(
        `No se puede cerrar ${MESES_ES[mes - 1]} ${anio}: hay ${pendientes?.total} registro(s) ` +
          `sin tarifa aprobada. Registre la tarifa del ${etiquetaTrimestre(anio, Math.ceil(mes / 3))}.`,
      );
    }

    await execute(
      `INSERT INTO cierres_mensuales (id_proyecto, anio, mes, estado, cerrado_por, fecha_cierre, motivo)
       VALUES (?, ?, ?, 'CERRADO', ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE estado = 'CERRADO', cerrado_por = VALUES(cerrado_por),
                               fecha_cierre = NOW(), motivo = VALUES(motivo)`,
      [idProyecto, anio, mes, req.usuario!.id_usuario, motivo ?? null],
    );

    await auditarDesdeRequest(req, {
      accion: 'PERIODO_CERRADO',
      entidad: 'cierres_mensuales',
      idEntidad: `${idProyecto}-${anio}-${mes}`,
      motivo: motivo ?? null,
    });

    ok(res, { mensaje: `Periodo ${MESES_ES[mes - 1]} ${anio} cerrado correctamente.` });
  }),
);

tarifasRouter.post(
  '/reopen',
  requierePermiso(PERMISOS.TARIFAS_REABRIR_MES),
  validarCuerpo(esquemaReapertura),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const { anio, mes, motivo } = req.body as z.infer<typeof esquemaReapertura>;

    const cierre = await queryOne('SELECT * FROM cierres_mensuales WHERE id_proyecto = ? AND anio = ? AND mes = ?', [
      idProyecto,
      anio,
      mes,
    ]);
    if (!cierre) throw errores.noEncontrado('un cierre para ese periodo');

    await execute(
      `UPDATE cierres_mensuales
          SET estado = 'ABIERTO', reabierto_por = ?, fecha_reapertura = NOW(), motivo = ?
        WHERE id_proyecto = ? AND anio = ? AND mes = ?`,
      [req.usuario!.id_usuario, motivo, idProyecto, anio, mes],
    );

    await auditarDesdeRequest(req, {
      accion: 'PERIODO_REABIERTO',
      entidad: 'cierres_mensuales',
      idEntidad: `${idProyecto}-${anio}-${mes}`,
      antes: cierre,
      motivo,
    });

    ok(res, { mensaje: `Periodo ${MESES_ES[mes - 1]} ${anio} reabierto. Quedo registrado el motivo.` });
  }),
);

// Se exporta para que el modulo de proyectos pueda reutilizar la validacion.
export { proyectoDe as proyectoDeRutaTarifas, exigirMesAbierto, trimestreSiguiente, nombreMesesTrimestre };
