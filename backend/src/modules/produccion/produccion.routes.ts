import { Router } from 'express';
import { z } from 'zod';
import { execute, queryOne, withTransaction } from '../../db/pool';
import { errores } from '../../utils/errors';
import {
  asyncHandler,
  columnaOrden,
  consulta,
  creado,
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
import {
  calcularValorizacion,
  coberturaTarifaria,
  exigirMesAbierto,
} from '../../services/valorizacion';
import * as consultas from '../../services/consultasProduccion';
import { hoyISO, periodoAnterior } from '../../utils/fechas';
import { calcularValorQ } from '../../utils/numeros';

export const produccionRouter = Router();
produccionRouter.use(requiereAutenticacion);

const esquemaFiltros = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  id_cliente: z.coerce.number().int().positive().optional(),
  id_proyecto: z.coerce.number().int().positive().optional(),
  id_inversor: z.coerce.number().int().positive().optional(),
  inversores: z.string().optional(),
});

function filtrosDesde(p: z.infer<typeof esquemaFiltros>): consultas.FiltrosProduccion {
  if (p.desde > p.hasta) {
    throw errores.validacion('La fecha inicial no puede ser posterior a la fecha final.');
  }
  return {
    desde: p.desde,
    hasta: p.hasta,
    idCliente: p.id_cliente ?? null,
    idProyecto: p.id_proyecto ?? null,
    idInversor: p.id_inversor ?? null,
    idsInversores: p.inversores
      ? p.inversores
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((v) => Number.isInteger(v) && v > 0)
      : null,
  };
}

const esquemaRegistro = z.object({
  id_proyecto: z.coerce.number().int().positive(),
  id_inversor: z.coerce.number().int().positive().optional().nullable(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  kwh: z.coerce.number().min(0, 'La energia no puede ser negativa.'),
  granularidad: z.enum(['DIARIA', 'MENSUAL']).default('DIARIA'),
  comentarios: z.string().trim().max(500).optional().nullable(),
});

const esquemaCorreccion = z.object({
  kwh: z.coerce.number().min(0, 'La energia no puede ser negativa.'),
  motivo: z.string().trim().min(10, 'Describa el motivo de la correccion (minimo 10 caracteres).').max(500),
  comentarios: z.string().trim().max(500).optional().nullable(),
});

const COLUMNAS = {
  fecha: 'p.fecha',
  kwh: 'p.kwh',
  valor: 'p.valor_q',
  proyecto: 'pr.nombre',
};

// ---------------------------------------------------------------------------
// GET /production  (detalle paginado)
// ---------------------------------------------------------------------------
produccionRouter.get(
  '/',
  requierePermiso(PERMISOS.PRODUCCION_VER),
  validarConsulta(esquemaPaginacion.merge(esquemaFiltros)),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquemaPaginacion> & z.infer<typeof esquemaFiltros>>(req);
    const { limite, desplazamiento } = limitesPaginacion(p);
    const resultado = await consultas.detalle(
      filtrosDesde(p),
      limite,
      desplazamiento,
      columnaOrden(p.orden, COLUMNAS, 'p.fecha'),
      p.direccion === 'asc' ? 'ASC' : 'DESC',
    );
    ok(res, resultado.filas, metaPaginacion(p, resultado.total));
  }),
);

// ---------------------------------------------------------------------------
// GET /production/summary
// ---------------------------------------------------------------------------
produccionRouter.get(
  '/summary',
  requierePermiso(PERMISOS.PRODUCCION_VER),
  validarConsulta(esquemaFiltros),
  asyncHandler(async (req, res) => {
    const filtros = filtrosDesde(consulta<z.infer<typeof esquemaFiltros>>(req));
    const [datos, cobertura, mezcla] = await Promise.all([
      consultas.resumen(filtros),
      coberturaTarifaria(
        {
          idProyecto: filtros.idProyecto,
          idCliente: filtros.idCliente,
          desde: filtros.desde,
          hasta: filtros.hasta,
        },
      ),
      consultas.periodosConMezclaDeNiveles(filtros),
    ]);

    ok(res, {
      ...datos,
      coberturaTarifaria: cobertura,
      periodosConMezclaDeNiveles: mezcla,
      moneda: 'GTQ',
      unidadEnergia: 'kWh',
      zonaHoraria: 'America/Guatemala',
      generadoEn: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /production/timeseries
// ---------------------------------------------------------------------------
produccionRouter.get(
  '/timeseries',
  requierePermiso(PERMISOS.PRODUCCION_VER),
  validarConsulta(
    esquemaFiltros.extend({ granularidad: z.enum(['DIARIA', 'MENSUAL', 'ANUAL']).default('MENSUAL') }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquemaFiltros> & { granularidad: consultas.Granularidad }>(req);
    const serie = await consultas.serieTemporal(filtrosDesde(p), p.granularidad);
    ok(res, serie, { granularidad: p.granularidad, unidad: 'kWh', moneda: 'GTQ' });
  }),
);

// ---------------------------------------------------------------------------
// GET /production/compare  (periodo anterior equivalente + proyectos/inversores)
// ---------------------------------------------------------------------------
produccionRouter.get(
  '/compare',
  requierePermiso(PERMISOS.PRODUCCION_VER),
  validarConsulta(esquemaFiltros),
  asyncHandler(async (req, res) => {
    const filtros = filtrosDesde(consulta<z.infer<typeof esquemaFiltros>>(req));
    const anterior = periodoAnterior({ desde: filtros.desde, hasta: filtros.hasta });

    const [comparacion, proyectos, inversores, rendimiento] = await Promise.all([
      consultas.compararPeriodos(filtros, { ...filtros, ...anterior }),
      consultas.porProyecto(filtros),
      consultas.porInversor(filtros),
      consultas.rendimientoRelativo(filtros),
    ]);

    ok(res, { ...comparacion, proyectos, inversores, rendimiento });
  }),
);

// ---------------------------------------------------------------------------
// GET /production/annual-summary  (vista equivalente al Excel de referencia)
// ---------------------------------------------------------------------------
produccionRouter.get(
  '/annual-summary',
  requierePermiso(PERMISOS.PRODUCCION_VER),
  validarConsulta(
    z.object({
      anio: z.coerce.number().int().min(2000).max(2100),
      id_proyecto: z.coerce.number().int().positive().optional(),
      id_cliente: z.coerce.number().int().positive().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<{ anio: number; id_proyecto?: number; id_cliente?: number }>(req);
    const resultado = await consultas.resumenAnual(p.anio, p.id_proyecto ?? null, p.id_cliente ?? null);
    ok(res, resultado, {
      anio: p.anio,
      advertencia:
        resultado.totales.mesesPendientes && Number(resultado.totales.mesesPendientes) > 0
          ? `Existen ${resultado.totales.mesesPendientes} mes(es) con produccion sin tarifa aprobada. El valor monetario mostrado es parcial.`
          : null,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /production  (registro manual)
// ---------------------------------------------------------------------------
produccionRouter.post(
  '/',
  requierePermiso(PERMISOS.PRODUCCION_REGISTRAR),
  validarCuerpo(esquemaRegistro),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaRegistro>;
    const anio = Number(datos.fecha.slice(0, 4));
    const mes = Number(datos.fecha.slice(5, 7));

    if (datos.fecha > hoyISO()) {
      throw errores.validacion('No se puede registrar produccion con fecha futura.');
    }

    const proyecto = await queryOne('SELECT id_proyecto FROM proyectos WHERE id_proyecto = ?', [
      datos.id_proyecto,
    ]);
    if (!proyecto) throw errores.validacion('El proyecto indicado no existe.');

    // Regla de negocio: no se puede registrar produccion sin inversor, salvo
    // que se declare explicitamente como consolidado del proyecto.
    let nivel: 'POR_INVERSOR' | 'PROYECTO_CONSOLIDADO' = 'PROYECTO_CONSOLIDADO';
    if (datos.id_inversor) {
      const inversor = await queryOne<{ id_proyecto: number }>(
        'SELECT id_proyecto FROM inversores WHERE id_inversor = ?',
        [datos.id_inversor],
      );
      if (!inversor) throw errores.validacion('El inversor indicado no existe.');
      if (inversor.id_proyecto !== datos.id_proyecto) {
        throw errores.validacion('El inversor seleccionado no pertenece al proyecto indicado.');
      }
      nivel = 'POR_INVERSOR';
    }

    await exigirMesAbierto(datos.id_proyecto, anio, mes);

    // Fecha normalizada: la produccion mensual se ancla al dia 1.
    const fecha = datos.granularidad === 'MENSUAL' ? `${datos.fecha.slice(0, 7)}-01` : datos.fecha;

    const existente = await queryOne<{ id_produccion: number }>(
      `SELECT id_produccion FROM produccion
        WHERE id_proyecto = ? AND COALESCE(id_inversor, 0) = ? AND fecha = ?
          AND granularidad = ? AND origen = 'MANUAL' AND secuencia = 0`,
      [datos.id_proyecto, datos.id_inversor ?? 0, fecha, datos.granularidad],
    );
    if (existente) {
      throw errores.conflicto(
        'Ya existe un registro manual para ese inversor/proyecto, fecha y granularidad. Utilice la correccion en lugar de duplicar.',
        { id_produccion: existente.id_produccion },
      );
    }

    const valorizacion = await calcularValorizacion(datos.id_proyecto, anio, mes, datos.kwh);

    const resultado = await execute(
      `INSERT INTO produccion
         (id_proyecto, id_inversor, nivel_detalle, fecha, anio, mes, granularidad, kwh,
          origen, secuencia, id_tarifa, costo_kwh_aplicado, valor_q, estado_valorizacion,
          comentarios, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 0, ?, ?, ?, ?, ?, ?)`,
      [
        datos.id_proyecto,
        datos.id_inversor ?? null,
        nivel,
        fecha,
        anio,
        mes,
        datos.granularidad,
        datos.kwh,
        valorizacion.id_tarifa,
        valorizacion.costo_kwh_aplicado,
        valorizacion.valor_q,
        valorizacion.estado_valorizacion,
        datos.comentarios || null,
        req.usuario!.id_usuario,
      ],
    );

    if (datos.id_inversor) {
      await execute(
        'UPDATE inversores SET ultima_actualizacion = GREATEST(COALESCE(ultima_actualizacion, ?), ?) WHERE id_inversor = ?',
        [fecha, fecha, datos.id_inversor],
      );
    }

    await auditarDesdeRequest(req, {
      accion: 'PRODUCCION_REGISTRADA',
      entidad: 'produccion',
      idEntidad: resultado.insertId,
      despues: { ...datos, ...valorizacion },
    });

    creado(res, {
      id_produccion: resultado.insertId,
      ...valorizacion,
      mensaje:
        valorizacion.estado_valorizacion === 'PENDIENTE_DE_TARIFA'
          ? 'Produccion registrada. El mes no tiene tarifa aprobada, por lo que el valor economico queda PENDIENTE DE TARIFA.'
          : 'Produccion registrada y valorizada correctamente.',
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /production/:id  (correccion manual con motivo y auditoria)
// ---------------------------------------------------------------------------
produccionRouter.put(
  '/:id',
  requierePermiso(PERMISOS.PRODUCCION_CORREGIR),
  validarCuerpo(esquemaCorreccion),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const datos = req.body as z.infer<typeof esquemaCorreccion>;

    const registro = await queryOne<{
      id_produccion: number;
      id_proyecto: number;
      id_inversor: number | null;
      anio: number;
      mes: number;
      kwh: number;
      valor_q: number | null;
      costo_kwh_aplicado: number | null;
      id_tarifa: number | null;
      estado_valorizacion: string;
    }>('SELECT * FROM produccion WHERE id_produccion = ? AND activo = 1', [id]);
    if (!registro) throw errores.noEncontrado('el registro de produccion');

    await exigirMesAbierto(registro.id_proyecto, registro.anio, registro.mes);

    // `valor_q` SIEMPRE se deriva de kwh x tarifa: nunca se edita a mano.
    const nuevoValor =
      registro.costo_kwh_aplicado !== null
        ? calcularValorQ(datos.kwh, registro.costo_kwh_aplicado)
        : null;

    await withTransaction(async (conn) => {
      await execute(
        `UPDATE produccion
            SET kwh = ?, valor_q = ?, comentarios = ?, updated_by = ?
          WHERE id_produccion = ?`,
        [datos.kwh, nuevoValor, datos.comentarios ?? null, req.usuario!.id_usuario, id],
        conn,
      );
      await execute(
        `INSERT INTO produccion_ajustes
           (id_produccion, kwh_antes, kwh_despues, valor_antes, valor_despues, motivo, id_usuario)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, registro.kwh, datos.kwh, registro.valor_q, nuevoValor, datos.motivo, req.usuario!.id_usuario],
        conn,
      );
    });

    await auditarDesdeRequest(req, {
      accion: 'PRODUCCION_CORREGIDA',
      entidad: 'produccion',
      idEntidad: id,
      antes: { kwh: registro.kwh, valor_q: registro.valor_q },
      despues: { kwh: datos.kwh, valor_q: nuevoValor },
      motivo: datos.motivo,
    });

    ok(res, {
      kwh: datos.kwh,
      valor_q: nuevoValor,
      mensaje:
        nuevoValor === null
          ? 'Registro corregido. Sigue pendiente de tarifa, por lo que no tiene valor economico.'
          : 'Registro corregido y revalorizado con la tarifa de su propio mes.',
    });
  }),
);
