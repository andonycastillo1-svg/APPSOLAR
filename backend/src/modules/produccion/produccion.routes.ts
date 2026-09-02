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
  CacheTarifas,
  calcularValorizacion,
  coberturaTarifaria,
  exigirMesAbierto,
} from '../../services/valorizacion';
import * as consultas from '../../services/consultasProduccion';
import { hoyISO, periodoAnterior } from '../../utils/fechas';
import { calcularValorQ, redondearKwh } from '../../utils/numeros';

export const produccionRouter = Router();
produccionRouter.use(requiereAutenticacion);

const esquemaFiltros = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  id_cliente: z.coerce.number().int().positive().optional(),
  id_proyecto: z.coerce.number().int().positive().optional(),
  id_grupo: z.coerce.number().int().positive().optional(),
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
    idGrupo: p.id_grupo ?? null,
    idInversor: p.id_inversor ?? null,
    idsInversores: p.inversores
      ? p.inversores
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((v) => Number.isInteger(v) && v > 0)
      : null,
  };
}

/**
 * Registro manual de produccion.
 *
 * Admite los tres niveles de la jerarquia:
 *   - con id_inversor            -> POR_INVERSOR
 *   - con id_grupo (sin inversor)-> GRUPO_CONSOLIDADO
 *   - sin ninguno de los dos     -> PROYECTO_CONSOLIDADO
 *
 * El nivel de grupo cubre el caso critico del alcance: cuando un grupo pierde
 * la conexion con Huawei durante un rango de fechas, el operador carga la
 * energia del grupo completo para no dejar huecos en el historico.
 */
const esquemaRegistro = z.object({
  id_proyecto: z.coerce.number().int().positive(),
  id_grupo: z.coerce.number().int().positive().optional().nullable(),
  id_inversor: z.coerce.number().int().positive().optional().nullable(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  kwh: z.coerce.number().min(0, 'La energia no puede ser negativa.'),
  granularidad: z.enum(['DIARIA', 'MENSUAL']).default('DIARIA'),
  comentarios: z.string().trim().max(500).optional().nullable(),
});

/** Carga manual de un rango completo para un grupo sin datos del fabricante. */
const esquemaRangoGrupo = z.object({
  id_grupo: z.coerce.number().int().positive(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  modo: z.enum(['TOTAL_DISTRIBUIDO', 'DIARIO_UNIFORME']).default('TOTAL_DISTRIBUIDO'),
  kwh: z.coerce.number().min(0, 'La energia no puede ser negativa.'),
  motivo: z
    .string()
    .trim()
    .min(10, 'Explique por que se carga manualmente (minimo 10 caracteres).')
    .max(500),
  sobrescribir: z.boolean().default(false),
  confirmarMezclaGranularidad: z.boolean().default(false),
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

    // El nivel de detalle se deduce de lo que el usuario haya indicado.
    let nivel: 'POR_INVERSOR' | 'GRUPO_CONSOLIDADO' | 'PROYECTO_CONSOLIDADO' =
      'PROYECTO_CONSOLIDADO';
    let idGrupo: number | null = datos.id_grupo ?? null;

    if (datos.id_inversor) {
      const inversor = await queryOne<{ id_proyecto: number; id_grupo: number }>(
        'SELECT id_proyecto, id_grupo FROM inversores WHERE id_inversor = ?',
        [datos.id_inversor],
      );
      if (!inversor) throw errores.validacion('El inversor indicado no existe.');
      if (inversor.id_proyecto !== datos.id_proyecto) {
        throw errores.validacion('El inversor seleccionado no pertenece al proyecto indicado.');
      }
      if (idGrupo && idGrupo !== inversor.id_grupo) {
        throw errores.validacion('El inversor seleccionado no pertenece al grupo indicado.');
      }
      // El grupo se hereda del inversor: la jerarquia siempre queda coherente.
      idGrupo = inversor.id_grupo;
      nivel = 'POR_INVERSOR';
    } else if (idGrupo) {
      const grupo = await queryOne<{ id_proyecto: number; activo: number }>(
        'SELECT id_proyecto, activo FROM grupos WHERE id_grupo = ?',
        [idGrupo],
      );
      if (!grupo) throw errores.validacion('El grupo indicado no existe.');
      if (grupo.id_proyecto !== datos.id_proyecto) {
        throw errores.validacion('El grupo seleccionado no pertenece al proyecto indicado.');
      }
      if (!grupo.activo) {
        throw errores.reglaNegocio('No es posible registrar produccion en un grupo desactivado.');
      }
      nivel = 'GRUPO_CONSOLIDADO';
    }

    await exigirMesAbierto(datos.id_proyecto, anio, mes);

    // Fecha normalizada: la produccion mensual se ancla al dia 1.
    const fecha = datos.granularidad === 'MENSUAL' ? `${datos.fecha.slice(0, 7)}-01` : datos.fecha;

    const existente = await queryOne<{ id_produccion: number }>(
      `SELECT id_produccion FROM produccion
        WHERE id_proyecto = ? AND COALESCE(id_grupo, 0) = ? AND COALESCE(id_inversor, 0) = ?
          AND fecha = ? AND granularidad = ? AND origen = 'MANUAL' AND secuencia = 0`,
      [datos.id_proyecto, idGrupo ?? 0, datos.id_inversor ?? 0, fecha, datos.granularidad],
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
         (id_proyecto, id_inversor, id_grupo, nivel_detalle, fecha, anio, mes, granularidad, kwh,
          origen, secuencia, id_tarifa, costo_kwh_aplicado, valor_q, estado_valorizacion,
          comentarios, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 0, ?, ?, ?, ?, ?, ?)`,
      [
        datos.id_proyecto,
        datos.id_inversor ?? null,
        idGrupo,
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

// ---------------------------------------------------------------------------
// GET /production/by-group
//
// Desglose de la generacion por grupo de inversores. Es la vista natural de la
// jerarquia PROYECTO -> GRUPO -> INVERSOR y permite comparar bloques entre si.
// ---------------------------------------------------------------------------
produccionRouter.get(
  '/by-group',
  requierePermiso(PERMISOS.PRODUCCION_VER),
  validarConsulta(esquemaFiltros),
  asyncHandler(async (req, res) => {
    const filtros = filtrosDesde(consulta<z.infer<typeof esquemaFiltros>>(req));
    const grupos = await consultas.porGrupo(filtros);

    ok(res, grupos, {
      periodo: { desde: filtros.desde, hasta: filtros.hasta },
      totales: {
        grupos: grupos.length,
        kwh: grupos.reduce((a, g) => a + Number(g.kwh), 0),
        valor_q: grupos.reduce((a, g) => a + Number(g.valor_q), 0),
      },
      unidadEnergia: 'kWh',
      moneda: 'GTQ',
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /production/gaps
//
// Detecta los dias SIN datos de cada grupo dentro de un periodo. Es el punto
// de partida del requerimiento de carga manual: cuando un grupo pierde la
// conexion con Huawei, el operador necesita ver exactamente que le falta.
// ---------------------------------------------------------------------------
produccionRouter.get(
  '/gaps',
  requierePermiso(PERMISOS.PRODUCCION_VER),
  validarConsulta(esquemaFiltros),
  asyncHandler(async (req, res) => {
    const filtros = filtrosDesde(consulta<z.infer<typeof esquemaFiltros>>(req));
    const huecos = await consultas.huecosDeDatos(filtros);

    ok(res, huecos, {
      periodo: { desde: filtros.desde, hasta: filtros.hasta },
      gruposConHuecos: huecos.length,
      diasFaltantesTotales: huecos.reduce((a, h) => a + Number(h.dias_faltantes), 0),
      explicacion:
        'Se comparan los dias del periodo contra las lecturas DIARIAS registradas de cada grupo. ' +
        'Un grupo con dias faltantes puede completarse manualmente sin esperar al fabricante.',
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /production/group-range
//
// Carga manual de un rango completo para un grupo. Cubre el caso en que un
// grupo de inversores no tiene datos de Huawei por fallas de conexion: el
// operador captura la energia y el sistema la distribuye por dia, quedando
// registrada como GRUPO_CONSOLIDADO con su motivo y su auditoria.
// ---------------------------------------------------------------------------
produccionRouter.post(
  '/group-range',
  requierePermiso(PERMISOS.PRODUCCION_REGISTRAR),
  validarCuerpo(esquemaRangoGrupo),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaRangoGrupo>;

    if (datos.desde > datos.hasta) {
      throw errores.validacion('La fecha inicial no puede ser posterior a la fecha final.');
    }
    if (datos.hasta > hoyISO()) {
      throw errores.validacion('No se puede registrar produccion con fecha futura.');
    }

    const grupo = await queryOne<{
      id_grupo: number;
      id_proyecto: number;
      nombre: string;
      activo: number;
    }>('SELECT id_grupo, id_proyecto, nombre, activo FROM grupos WHERE id_grupo = ?', [
      datos.id_grupo,
    ]);
    if (!grupo) throw errores.noEncontrado('el grupo indicado');
    if (!grupo.activo) {
      throw errores.reglaNegocio('No es posible registrar produccion en un grupo desactivado.');
    }

    // Dias del rango, en fechas civiles sin componente de hora.
    const dias: string[] = [];
    const cursor = new Date(`${datos.desde}T00:00:00Z`);
    const fin = new Date(`${datos.hasta}T00:00:00Z`);
    while (cursor <= fin) {
      dias.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (dias.length > 400) {
        throw errores.validacion('El rango no puede superar los 400 dias. Divida la carga.');
      }
    }

    // TOTAL_DISTRIBUIDO: el valor capturado es el total del rango y se reparte.
    // DIARIO_UNIFORME:   el valor capturado es el de cada dia.
    const kwhPorDia =
      datos.modo === 'DIARIO_UNIFORME' ? datos.kwh : redondearKwh(datos.kwh / dias.length);

    // Ningun mes del rango puede estar cerrado.
    const mesesDelRango = [...new Set(dias.map((d) => d.slice(0, 7)))];
    for (const periodo of mesesDelRango) {
      await exigirMesAbierto(
        grupo.id_proyecto,
        Number(periodo.slice(0, 4)),
        Number(periodo.slice(5, 7)),
      );
    }

    // Guardia contra el doble conteo por mezcla de granularidades.
    //
    // Si el grupo ya tiene un cierre MENSUAL de alguno de esos meses, ese
    // registro ya representa el mes completo: agregarle dias sueltos contaria
    // la misma energia dos veces. En ese caso lo correcto es corregir la cifra
    // mensual, no rellenar dias. Se permite continuar solo con confirmacion
    // explicita del operador.
    if (!datos.confirmarMezclaGranularidad) {
      const conflictos: string[] = [];
      for (const periodo of mesesDelRango) {
        const mensual = await queryOne<{ total: number; kwh: number }>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(kwh), 0) AS kwh
             FROM produccion
            WHERE id_grupo = ? AND activo = 1 AND granularidad = 'MENSUAL'
              AND anio = ? AND mes = ?`,
          [grupo.id_grupo, Number(periodo.slice(0, 4)), Number(periodo.slice(5, 7))],
        );
        if (Number(mensual?.total ?? 0) > 0) {
          conflictos.push(`${periodo} (${Number(mensual!.kwh).toLocaleString('es-GT')} kWh mensuales)`);
        }
      }

      if (conflictos.length > 0) {
        throw errores.reglaNegocio(
          `El grupo "${grupo.nombre}" ya tiene produccion MENSUAL registrada en ${conflictos.join(', ')}. ` +
            'Esa cifra ya cubre el mes completo, por lo que agregar dias sueltos contaria la energia dos veces. ' +
            'Corrija el registro mensual o confirme expresamente la mezcla de granularidades.',
          { conflictos },
        );
      }
    }

    let insertados = 0;
    let actualizados = 0;
    let omitidos = 0;
    let pendientesTarifa = 0;

    await withTransaction(async (conn) => {
      const cache = new CacheTarifas(conn);

      for (const fecha of dias) {
        const anio = Number(fecha.slice(0, 4));
        const mes = Number(fecha.slice(5, 7));

        const existente = await queryOne<{ id_produccion: number }>(
          `SELECT id_produccion FROM produccion
            WHERE id_proyecto = ? AND COALESCE(id_grupo, 0) = ? AND COALESCE(id_inversor, 0) = 0
              AND fecha = ? AND granularidad = 'DIARIA' AND origen = 'MANUAL' AND secuencia = 0`,
          [grupo.id_proyecto, grupo.id_grupo, fecha],
          conn,
        );

        if (existente && !datos.sobrescribir) {
          omitidos += 1;
          continue;
        }

        const valorizacion = await calcularValorizacion(
          grupo.id_proyecto,
          anio,
          mes,
          kwhPorDia,
          cache,
          conn,
        );
        if (valorizacion.estado_valorizacion === 'PENDIENTE_DE_TARIFA') pendientesTarifa += 1;

        const comentario =
          `Carga manual por falta de datos del fabricante. ${datos.motivo}`.slice(0, 500);

        if (existente) {
          await execute(
            `UPDATE produccion
                SET kwh = ?, id_tarifa = ?, costo_kwh_aplicado = ?, valor_q = ?,
                    estado_valorizacion = ?, comentarios = ?, updated_by = ?
              WHERE id_produccion = ?`,
            [
              kwhPorDia,
              valorizacion.id_tarifa,
              valorizacion.costo_kwh_aplicado,
              valorizacion.valor_q,
              valorizacion.estado_valorizacion,
              comentario,
              req.usuario!.id_usuario,
              existente.id_produccion,
            ],
            conn,
          );
          actualizados += 1;
        } else {
          await execute(
            `INSERT INTO produccion
               (id_proyecto, id_inversor, id_grupo, nivel_detalle, fecha, anio, mes,
                granularidad, kwh, origen, secuencia, id_tarifa, costo_kwh_aplicado,
                valor_q, estado_valorizacion, comentarios, created_by)
             VALUES (?, NULL, ?, 'GRUPO_CONSOLIDADO', ?, ?, ?, 'DIARIA', ?, 'MANUAL', 0, ?, ?, ?, ?, ?, ?)`,
            [
              grupo.id_proyecto,
              grupo.id_grupo,
              fecha,
              anio,
              mes,
              kwhPorDia,
              valorizacion.id_tarifa,
              valorizacion.costo_kwh_aplicado,
              valorizacion.valor_q,
              valorizacion.estado_valorizacion,
              comentario,
              req.usuario!.id_usuario,
            ],
            conn,
          );
          insertados += 1;
        }
      }
    });

    await auditarDesdeRequest(req, {
      accion: 'PRODUCCION_CARGA_MANUAL_GRUPO',
      entidad: 'grupos',
      idEntidad: grupo.id_grupo,
      despues: {
        grupo: grupo.nombre,
        periodo: [datos.desde, datos.hasta],
        modo: datos.modo,
        kwh_total: datos.kwh,
        kwh_por_dia: kwhPorDia,
        insertados,
        actualizados,
        omitidos,
      },
      motivo: datos.motivo,
    });

    creado(res, {
      id_grupo: grupo.id_grupo,
      grupo: grupo.nombre,
      dias: dias.length,
      kwh_por_dia: kwhPorDia,
      insertados,
      actualizados,
      omitidos,
      pendientesTarifa,
      nivel_detalle: 'GRUPO_CONSOLIDADO',
      mensaje:
        `Se registraron ${insertados} dia(s) y se actualizaron ${actualizados} para el grupo ` +
        `"${grupo.nombre}" a ${kwhPorDia} kWh por dia.` +
        (omitidos > 0
          ? ` Se omitieron ${omitidos} dia(s) que ya tenian datos; marque "sobrescribir" si desea reemplazarlos.`
          : '') +
        (pendientesTarifa > 0 ? ` ${pendientesTarifa} dia(s) quedaron pendientes de tarifa.` : ''),
    });
  }),
);
