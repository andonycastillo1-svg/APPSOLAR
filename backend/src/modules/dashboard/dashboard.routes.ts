import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool';
import { asyncHandler, consulta, ok, validarConsulta } from '../../utils/http';
import { requiereAutenticacion, requierePermiso } from '../../middleware/autenticacion';
import { PERMISOS } from '../../config/permisos';
import * as consultas from '../../services/consultasProduccion';
import { coberturaTarifaria } from '../../services/valorizacion';
import { factoresAmbientales } from '../../services/configuracion';
import { errores } from '../../utils/errors';
import { hoyISO, mesesDelPeriodo, periodoAnterior, MESES_ES } from '../../utils/fechas';
import { porcentajeCumplimiento, redondear } from '../../utils/numeros';

export const dashboardRouter = Router();
dashboardRouter.use(requiereAutenticacion);

const esquema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  id_cliente: z.coerce.number().int().positive().optional(),
  id_proyecto: z.coerce.number().int().positive().optional(),
  id_inversor: z.coerce.number().int().positive().optional(),
  granularidad: z.enum(['DIARIA', 'MENSUAL', 'ANUAL']).default('MENSUAL'),
});

dashboardRouter.get(
  '/',
  requierePermiso(PERMISOS.DASHBOARD_VER),
  validarConsulta(esquema),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquema>>(req);
    const hoy = hoyISO();
    const desde = p.desde ?? `${hoy.slice(0, 4)}-01-01`;
    const hasta = p.hasta ?? hoy;

    if (desde > hasta) {
      throw errores.validacion('La fecha inicial no puede ser posterior a la fecha final.');
    }

    const filtros: consultas.FiltrosProduccion = {
      desde,
      hasta,
      idCliente: p.id_cliente ?? null,
      idProyecto: p.id_proyecto ?? null,
      idInversor: p.id_inversor ?? null,
    };
    const anterior = periodoAnterior({ desde, hasta });

    const [
      resumenPeriodo,
      resumenAnterior,
      serie,
      distribucion,
      inversores,
      rendimiento,
      cobertura,
      mezcla,
      ambiental,
    ] = await Promise.all([
      consultas.resumen(filtros),
      consultas.resumen({ ...filtros, ...anterior }),
      consultas.serieTemporal(filtros, p.granularidad),
      consultas.porProyecto(filtros),
      consultas.porInversor(filtros),
      consultas.rendimientoRelativo(filtros),
      coberturaTarifaria({
        idProyecto: filtros.idProyecto,
        idCliente: filtros.idCliente,
        desde,
        hasta,
      }),
      consultas.periodosConMezclaDeNiveles(filtros),
      factoresAmbientales(),
    ]);

    // --- Produccion del dia, mes y anio en curso -------------------------
    const [dia, mes, anio] = await Promise.all([
      consultas.resumen({ ...filtros, desde: hoy, hasta: hoy }),
      consultas.resumen({ ...filtros, desde: `${hoy.slice(0, 7)}-01`, hasta: hoy }),
      consultas.resumen({ ...filtros, desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy }),
    ]);

    // --- Proyeccion del periodo (suma de los meses cubiertos) ------------
    const meses = mesesDelPeriodo({ desde, hasta });
    const condicionesProy: string[] = ["pj.estado = 'APROBADA'"];
    const paramsProy: unknown[] = [];
    if (meses.length > 0) {
      condicionesProy.push(
        `(${meses.map(() => '(pj.anio = ? AND pj.mes = ?)').join(' OR ')})`,
      );
      for (const m of meses) paramsProy.push(m.anio, m.mes);
    }
    if (filtros.idProyecto) {
      condicionesProy.push('pj.id_proyecto = ?');
      paramsProy.push(filtros.idProyecto);
    }
    if (filtros.idCliente) {
      condicionesProy.push('pr.id_cliente = ?');
      paramsProy.push(filtros.idCliente);
    }

    // `meses` cuenta periodos distintos, no filas: al abarcar varios proyectos
    // un mismo mes aparece una vez por proyecto y el conteo seria enganoso.
    const proyeccion = await queryOne<{ total: number; meses: number }>(
      `SELECT COALESCE(SUM(pj.proyeccion_kwh), 0) AS total,
              COUNT(DISTINCT CONCAT(pj.anio, '-', pj.mes)) AS meses
         FROM proyecciones_kwh pj JOIN proyectos pr ON pr.id_proyecto = pj.id_proyecto
        WHERE ${condicionesProy.join(' AND ')}`,
      paramsProy,
    );
    const proyeccionKwh = Number(proyeccion?.total ?? 0);

    // --- Tarifas aplicadas mes a mes en el periodo ----------------------
    const tarifasPeriodo = meses.length
      ? await query<{ anio: number; mes: number; proyecto: string; costo_kwh: number; estado: string }>(
          `SELECT t.anio, t.mes, pr.nombre AS proyecto, t.costo_kwh, t.estado
             FROM tarifas_kwh t JOIN proyectos pr ON pr.id_proyecto = t.id_proyecto
            WHERE t.estado = 'APROBADA'
              AND (${meses.map(() => '(t.anio = ? AND t.mes = ?)').join(' OR ')})
              ${filtros.idProyecto ? 'AND t.id_proyecto = ?' : ''}
              ${filtros.idCliente ? 'AND pr.id_cliente = ?' : ''}
            ORDER BY t.anio, t.mes, pr.nombre`,
          [
            ...meses.flatMap((m) => [m.anio, m.mes]),
            ...(filtros.idProyecto ? [filtros.idProyecto] : []),
            ...(filtros.idCliente ? [filtros.idCliente] : []),
          ],
        )
      : [];

    // --- Conteos y ultimas actualizaciones -------------------------------
    const conteos = await queryOne<{ clientes: number; proyectos: number; inversores: number }>(
      `SELECT (SELECT COUNT(*) FROM clientes WHERE activo = 1) AS clientes,
              (SELECT COUNT(*) FROM proyectos WHERE activo = 1) AS proyectos,
              (SELECT COUNT(*) FROM inversores WHERE activo = 1) AS inversores`,
    );

    const actualizaciones = await query(
      `SELECT pr.id_proyecto, pr.nombre AS proyecto,
              MAX(p.fecha) AS ultima_fecha, MAX(p.updated_at) AS ultima_carga
         FROM proyectos pr LEFT JOIN produccion p ON p.id_proyecto = pr.id_proyecto AND p.activo = 1
        WHERE pr.activo = 1 ${filtros.idProyecto ? 'AND pr.id_proyecto = ?' : ''}
        GROUP BY pr.id_proyecto, pr.nombre ORDER BY pr.nombre`,
      filtros.idProyecto ? [filtros.idProyecto] : [],
    );

    const ultimaImportacion = await queryOne(
      `SELECT h.id_historico, h.nombre_archivo_original, h.estado, h.total_filas,
              h.insertadas, h.rechazadas, h.created_at, u.nombre AS usuario
         FROM historicos h LEFT JOIN usuarios u ON u.id_usuario = h.id_usuario
        ORDER BY h.created_at DESC LIMIT 1`,
    );

    const ultimaSincronizacion = await queryOne(
      `SELECT s.id_sync, s.estado, s.modo, s.tipo, s.rango_desde, s.rango_hasta,
              s.filas_recibidas, s.insertadas, s.mensaje, s.iniciada_en, u.nombre AS usuario
         FROM sincronizaciones s LEFT JOIN usuarios u ON u.id_usuario = s.id_usuario
        ORDER BY s.iniciada_en DESC LIMIT 1`,
    );

    // --- Equivalencias ambientales (factores configurables) --------------
    const mwh = resumenPeriodo.kwh / 1000;
    const toneladasCo2 = redondear(mwh * ambiental.factorCo2, 4);
    const arboles = ambiental.co2PorArbol > 0 ? Math.round(toneladasCo2 / ambiental.co2PorArbol) : 0;

    ok(res, {
      periodo: { desde, hasta, comparadoCon: anterior },
      produccion: {
        periodo_kwh: resumenPeriodo.kwh,
        valor_q: resumenPeriodo.valor_q,
        registros: resumenPeriodo.registros,
        dia_kwh: dia.kwh,
        mes_kwh: mes.kwh,
        anio_kwh: anio.kwh,
      },
      variacion: {
        base: `Periodo anterior equivalente (${anterior.desde} a ${anterior.hasta})`,
        anterior_kwh: resumenAnterior.kwh,
        absoluta_kwh: redondear(resumenPeriodo.kwh - resumenAnterior.kwh, 4),
        porcentual_kwh:
          resumenAnterior.kwh > 0
            ? redondear(((resumenPeriodo.kwh - resumenAnterior.kwh) / resumenAnterior.kwh) * 100, 2)
            : null,
        anterior_valor_q: resumenAnterior.valor_q,
        absoluta_valor_q: redondear(resumenPeriodo.valor_q - resumenAnterior.valor_q, 4),
      },
      proyeccion: {
        kwh: redondear(proyeccionKwh, 4),
        mesesConProyeccion: Number(proyeccion?.meses ?? 0),
        mesesDelPeriodo: meses.length,
        cumplimiento: porcentajeCumplimiento(resumenPeriodo.kwh, proyeccionKwh || null),
        etiqueta: proyeccionKwh > 0 ? null : 'Sin proyeccion aprobada para el periodo',
      },
      tarifas: {
        aplicadasPorMes: tarifasPeriodo.map((t) => ({
          ...t,
          etiqueta: `${MESES_ES[t.mes - 1]} ${t.anio}`,
        })),
        cobertura,
        advertencia:
          cobertura.mesesPendientes.length > 0
            ? `Hay ${cobertura.mesesPendientes.length} mes(es) sin tarifa aprobada. El valor en quetzales es parcial.`
            : null,
      },
      catalogos: {
        clientes: Number(conteos?.clientes ?? 0),
        proyectos: Number(conteos?.proyectos ?? 0),
        inversores: Number(conteos?.inversores ?? 0),
      },
      serie,
      distribucionPorProyecto: distribucion,
      inversores,
      // Inversores con menor produccion relativa dentro del periodo comparado.
      inversoresMenorRendimiento: rendimiento.comparables.slice(0, 5),
      rendimiento,
      actualizaciones,
      ultimaImportacion,
      ultimaSincronizacion,
      periodosConMezclaDeNiveles: mezcla,
      ambiental: {
        toneladas_co2_evitadas: toneladasCo2,
        arboles_equivalentes: arboles,
        factor_co2: ambiental.factorCo2,
        factor_co2_unidad: ambiental.factorCo2Unidad,
        factor_co2_fuente: ambiental.factorCo2Fuente,
        co2_por_arbol: ambiental.co2PorArbol,
        co2_por_arbol_unidad: ambiental.co2PorArbolUnidad,
        co2_por_arbol_fuente: ambiental.co2PorArbolFuente,
      },
      meta: {
        moneda: 'GTQ',
        simbolo: 'Q',
        unidadEnergia: 'kWh',
        unidadPotencia: 'kWp',
        zonaHoraria: 'America/Guatemala',
        generadoEn: new Date().toISOString(),
      },
    });
  }),
);
