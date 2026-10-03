import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../../db/pool';
import { errores } from '../../utils/errors';
import {
  asyncHandler,
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
import * as consultas from '../../services/consultasProduccion';
import { coberturaTarifaria } from '../../services/valorizacion';
import { obtenerTexto } from '../../services/configuracion';
import { generarCsv, generarPdf, generarXlsx, type TablaReporte } from '../../services/exportacion';
import { MESES_ES, formatoLargoEs, periodoAnterior } from '../../utils/fechas';
import { redondear } from '../../utils/numeros';

export const reportesRouter = Router();
reportesRouter.use(requiereAutenticacion);

const TIPOS = ['PRODUCCION', 'RESUMEN_ANUAL', 'COMPARATIVO', 'VALORIZACION'] as const;

const esquemaGenerar = z.object({
  tipo: z.enum(TIPOS),
  nombre: z.string().trim().max(160).optional(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.'),
  id_cliente: z.coerce.number().int().positive().optional().nullable(),
  id_proyecto: z.coerce.number().int().positive().optional().nullable(),
  inversores: z.array(z.coerce.number().int().positive()).optional().nullable(),
  granularidad: z.enum(['DIARIA', 'MENSUAL', 'ANUAL']).default('MENSUAL'),
  anio: z.coerce.number().int().min(2000).max(2100).optional(),
  guardar: z.boolean().default(true),
});

type ParametrosReporte = z.infer<typeof esquemaGenerar>;

const formatoNumero = (valor: number | null | undefined, decimales = 2): string =>
  valor === null || valor === undefined
    ? 'Sin dato'
    : new Intl.NumberFormat('es-GT', {
        minimumFractionDigits: decimales,
        maximumFractionDigits: decimales,
      }).format(valor);

const formatoQ = (valor: number | null | undefined): string =>
  valor === null || valor === undefined ? 'Pendiente de tarifa' : `Q ${formatoNumero(valor, 2)}`;

/** Construye el contenido completo del reporte a partir de sus parametros. */
async function construirReporte(parametros: ParametrosReporte, usuario: string) {
  if (parametros.desde > parametros.hasta) {
    throw errores.validacion('La fecha inicial no puede ser posterior a la fecha final.');
  }

  const filtros: consultas.FiltrosProduccion = {
    desde: parametros.desde,
    hasta: parametros.hasta,
    idCliente: parametros.id_cliente ?? null,
    idProyecto: parametros.id_proyecto ?? null,
    idsInversores: parametros.inversores?.length ? parametros.inversores : null,
  };

  const anterior = periodoAnterior({ desde: parametros.desde, hasta: parametros.hasta });
  const anio = parametros.anio ?? Number(parametros.hasta.slice(0, 4));

  const [resumen, comparacion, serie, porProyecto, porInversor, rendimiento, cobertura, anual, empresa] =
    await Promise.all([
      consultas.resumen(filtros),
      consultas.compararPeriodos(filtros, { ...filtros, ...anterior }),
      consultas.serieTemporal(filtros, parametros.granularidad),
      consultas.porProyecto(filtros),
      consultas.porInversor(filtros),
      consultas.rendimientoRelativo(filtros),
      coberturaTarifaria({
        idProyecto: filtros.idProyecto,
        idCliente: filtros.idCliente,
        desde: parametros.desde,
        hasta: parametros.hasta,
      }),
      consultas.resumenAnual(anio, filtros.idProyecto, filtros.idCliente),
      obtenerTexto('empresa.nombre', 'Retse, S.A.'),
    ]);

  const cliente = filtros.idCliente
    ? await queryOne<{ nombre: string }>('SELECT nombre FROM clientes WHERE id_cliente = ?', [filtros.idCliente])
    : null;
  const proyecto = filtros.idProyecto
    ? await queryOne<{ nombre: string; tipo_proyecto: string }>(
        'SELECT nombre, tipo_proyecto FROM proyectos WHERE id_proyecto = ?',
        [filtros.idProyecto],
      )
    : null;

  // Desglose mensual integrado: proyeccion, real, cumplimiento, tarifa y valor.
  const desgloseMensual = anual.filas
    .filter((f) => f.generacion_anio_seleccionado > 0 || (f.proyeccion_kwh ?? 0) > 0)
    .map((f) => ({
      mes: `${f.mesNombre} ${anio}`,
      proyeccion_kwh: f.proyeccion_kwh,
      generacion_kwh: f.generacion_anio_seleccionado,
      cumplimiento: f.cumplimiento_anio_seleccionado,
      tarifa_q_kwh: f.tarifa_q_kwh,
      valor_q: f.valor_producido_q,
      estado: f.pendiente_de_tarifa ? 'PENDIENTE DE TARIFA' : 'VALORIZADO',
    }));

  const promedioDiario =
    serie.length > 0 ? redondear(resumen.kwh / Math.max(1, serie.length), 4) : 0;

  const notas: string[] = [
    `Periodo consultado: ${formatoLargoEs(parametros.desde)} al ${formatoLargoEs(parametros.hasta)} (zona horaria America/Guatemala).`,
    `Ultima actualizacion de datos en el periodo: ${resumen.ultimaFecha ? formatoLargoEs(resumen.ultimaFecha) : 'sin registros'}.`,
    'La tarifa del kWh tiene vigencia TRIMESTRAL. El valor economico se calcula registro por registro con la tarifa aprobada del trimestre correspondiente y luego se suma.',
    'Para evitar doble conteo, cuando un proyecto tiene detalle por inversor en un mes, el consolidado de ese mes no se suma.',
  ];

  if (!cobertura.completa) {
    notas.push(
      `ADVERTENCIA: existen ${cobertura.trimestresPendientes.length} trimestre(s) sin tarifa aprobada ` +
        `y ${cobertura.registrosPendientes} registro(s) sin valorizar. El monto en quetzales es PARCIAL.`,
    );
  }

  return {
    parametros,
    empresa,
    usuario,
    contexto: {
      cliente: cliente?.nombre ?? 'Todos los clientes',
      proyecto: proyecto?.nombre ?? 'Todos los proyectos',
      modalidad: proyecto?.tipo_proyecto ?? null,
      anio,
    },
    resumen: {
      ...resumen,
      promedioPorPeriodo: promedioDiario,
      granularidad: parametros.granularidad,
    },
    comparacion,
    serie,
    porProyecto,
    porInversor,
    rendimiento,
    cobertura,
    resumenAnual: anual,
    desgloseMensual,
    notas,
    generadoEn: new Date().toISOString(),
    moneda: 'GTQ',
    unidadEnergia: 'kWh',
    zonaHoraria: 'America/Guatemala',
  };
}

type Reporte = Awaited<ReturnType<typeof construirReporte>>;

function tablasDelReporte(reporte: Reporte): TablaReporte[] {
  const tablas: TablaReporte[] = [];

  tablas.push({
    titulo: 'Desglose mensual',
    columnas: [
      { clave: 'mes', titulo: 'Mes', ancho: 2 },
      { clave: 'proyeccion', titulo: 'Proyeccion kWh', ancho: 1.6, alineacion: 'right' },
      { clave: 'generacion', titulo: 'Generacion kWh', ancho: 1.6, alineacion: 'right' },
      { clave: 'cumplimiento', titulo: 'Cumplimiento', ancho: 1.2, alineacion: 'right' },
      { clave: 'tarifa', titulo: 'Tarifa Q/kWh', ancho: 1.3, alineacion: 'right' },
      { clave: 'valor', titulo: 'Valor producido', ancho: 1.7, alineacion: 'right' },
      { clave: 'estado', titulo: 'Estado', ancho: 1.6 },
    ],
    filas: reporte.desgloseMensual.map((f) => ({
      mes: f.mes,
      proyeccion: f.proyeccion_kwh === null ? 'Sin proyeccion' : formatoNumero(f.proyeccion_kwh),
      generacion: formatoNumero(f.generacion_kwh),
      cumplimiento: f.cumplimiento === null ? 'Sin proyeccion' : `${formatoNumero(f.cumplimiento)} %`,
      tarifa: f.tarifa_q_kwh === null ? 'Sin tarifa' : formatoNumero(f.tarifa_q_kwh, 6),
      valor: formatoQ(f.valor_q),
      estado: f.estado,
    })),
  });

  if (reporte.porProyecto.length > 0) {
    tablas.push({
      titulo: 'Produccion por proyecto',
      columnas: [
        { clave: 'proyecto', titulo: 'Proyecto', ancho: 2.4 },
        { clave: 'cliente', titulo: 'Cliente', ancho: 2 },
        { clave: 'tipo', titulo: 'Modalidad', ancho: 1 },
        { clave: 'kwh', titulo: 'kWh', ancho: 1.6, alineacion: 'right' },
        { clave: 'valor', titulo: 'Valor Q', ancho: 1.6, alineacion: 'right' },
        { clave: 'pendientes', titulo: 'Pendientes', ancho: 1, alineacion: 'right' },
      ],
      filas: reporte.porProyecto.map((p) => ({
        proyecto: p.proyecto,
        cliente: p.cliente,
        tipo: p.tipo_proyecto,
        kwh: formatoNumero(p.kwh),
        valor: formatoQ(p.valor_q),
        pendientes: String(p.pendientes),
      })),
    });
  }

  if (reporte.porInversor.length > 0) {
    tablas.push({
      titulo: 'Produccion por inversor',
      columnas: [
        { clave: 'inversor', titulo: 'Inversor', ancho: 2.8 },
        { clave: 'proyecto', titulo: 'Proyecto', ancho: 2 },
        { clave: 'kwp', titulo: 'kWp', ancho: 1, alineacion: 'right' },
        { clave: 'kwh', titulo: 'kWh', ancho: 1.5, alineacion: 'right' },
        { clave: 'valor', titulo: 'Valor Q', ancho: 1.5, alineacion: 'right' },
        { clave: 'ultima', titulo: 'Ultimo dato', ancho: 1.2 },
      ],
      filas: reporte.porInversor.map((i) => ({
        inversor: i.inversor,
        proyecto: i.proyecto,
        kwp: i.capacidad_kwp === null ? 'No registrada' : formatoNumero(i.capacidad_kwp, 3),
        kwh: formatoNumero(i.kwh),
        valor: formatoQ(i.valor_q),
        ultima: i.ultima_fecha ? formatoLargoEs(i.ultima_fecha) : 'Sin datos',
      })),
    });
  }

  tablas.push({
    titulo: 'Serie de produccion',
    columnas: [
      { clave: 'periodo', titulo: 'Periodo', ancho: 2 },
      { clave: 'kwh', titulo: 'kWh', ancho: 1.5, alineacion: 'right' },
      { clave: 'valor', titulo: 'Valor Q', ancho: 1.5, alineacion: 'right' },
    ],
    filas: reporte.serie.map((s) => ({
      periodo: s.etiqueta,
      kwh: formatoNumero(s.kwh),
      valor: formatoQ(s.valor_q),
    })),
  });

  return tablas;
}

function indicadoresDelReporte(reporte: Reporte) {
  const cumplimiento = reporte.resumenAnual.totales.cumplimiento_anio_seleccionado;
  return [
    { etiqueta: 'Produccion total del periodo', valor: `${formatoNumero(reporte.resumen.kwh)} kWh` },
    {
      etiqueta: 'Valor economico estimado',
      valor: formatoQ(reporte.resumen.valor_q),
      detalle: reporte.cobertura.completa ? undefined : 'Monto PARCIAL: hay meses sin tarifa',
    },
    {
      etiqueta: 'Variacion vs. periodo anterior',
      valor:
        reporte.comparacion.variacion.kwh_porcentual === null
          ? 'Sin base de comparacion'
          : `${formatoNumero(reporte.comparacion.variacion.kwh_porcentual)} %`,
      detalle: `${formatoNumero(reporte.comparacion.variacion.kwh_absoluta)} kWh`,
    },
    {
      etiqueta: `Cumplimiento anual ${reporte.contexto.anio}`,
      valor: cumplimiento === null ? 'Sin proyeccion' : `${formatoNumero(Number(cumplimiento))} %`,
    },
    {
      etiqueta: 'Promedio por periodo',
      valor: `${formatoNumero(reporte.resumen.promedioPorPeriodo)} kWh`,
      detalle: reporte.resumen.granularidad,
    },
    {
      etiqueta: 'Cobertura tarifaria',
      valor: reporte.cobertura.completa ? 'Completa' : 'Parcial',
      detalle: `${reporte.cobertura.trimestresConTarifa.length} trimestre(s) con tarifa / ${reporte.cobertura.trimestresPendientes.length} pendiente(s)`,
    },
  ];
}

function encabezadoDelReporte(reporte: Reporte) {
  return {
    titulo: `Reporte de ${reporte.parametros.tipo.toLowerCase().replace('_', ' ')}`,
    subtitulo: `${reporte.contexto.proyecto} | ${reporte.contexto.cliente}`,
    empresa: reporte.empresa,
    usuario: reporte.usuario,
    filtros: [
      { etiqueta: 'Cliente', valor: reporte.contexto.cliente },
      { etiqueta: 'Proyecto', valor: reporte.contexto.proyecto },
      {
        etiqueta: 'Inversores',
        valor: reporte.parametros.inversores?.length
          ? `${reporte.parametros.inversores.length} seleccionado(s)`
          : 'Todos',
      },
      {
        etiqueta: 'Periodo',
        valor: `${formatoLargoEs(reporte.parametros.desde)} al ${formatoLargoEs(reporte.parametros.hasta)}`,
      },
      { etiqueta: 'Granularidad', valor: reporte.parametros.granularidad },
      { etiqueta: 'Año de referencia', valor: String(reporte.contexto.anio) },
    ],
    notas: reporte.notas,
  };
}

// ---------------------------------------------------------------------------
// POST /reports/generate
// ---------------------------------------------------------------------------
reportesRouter.post(
  '/generate',
  requierePermiso(PERMISOS.REPORTES_GENERAR),
  validarCuerpo(esquemaGenerar),
  asyncHandler(async (req, res) => {
    const parametros = req.body as ParametrosReporte;
    const reporte = await construirReporte(parametros, req.usuario!.nombre);

    let idReporte: number | null = null;
    if (parametros.guardar) {
      const resultado = await execute(
        `INSERT INTO reportes
           (id_usuario, tipo, nombre, parametros, periodo_desde, periodo_hasta, resumen, cobertura_tarifaria)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.usuario!.id_usuario,
          parametros.tipo,
          parametros.nombre ??
            `${parametros.tipo} ${formatoLargoEs(parametros.desde)} - ${formatoLargoEs(parametros.hasta)}`,
          JSON.stringify(parametros),
          parametros.desde,
          parametros.hasta,
          JSON.stringify({
            kwh: reporte.resumen.kwh,
            valor_q: reporte.resumen.valor_q,
            registros: reporte.resumen.registros,
            mesesPendientes: reporte.cobertura.trimestresPendientes.length,
          }),
          reporte.cobertura.completa ? 'COMPLETA' : 'PARCIAL',
        ],
      );
      idReporte = resultado.insertId;

      await auditarDesdeRequest(req, {
        accion: 'REPORTE_GENERADO',
        entidad: 'reportes',
        idEntidad: idReporte,
        despues: { tipo: parametros.tipo, periodo: [parametros.desde, parametros.hasta] },
      });
    }

    creado(res, {
      id_reporte: idReporte,
      ...reporte,
      advertenciaOficial: reporte.cobertura.completa
        ? null
        : `Este reporte NO puede considerarse un documento oficial completo: hay ${reporte.cobertura.trimestresPendientes.length} mes(es) sin tarifa aprobada, por lo que el monto en quetzales es parcial.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /reports  (historial)
// ---------------------------------------------------------------------------
reportesRouter.get(
  '/',
  requierePermiso(PERMISOS.REPORTES_VER),
  validarConsulta(esquemaPaginacion.extend({ tipo: z.enum(TIPOS).optional() })),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquemaPaginacion> & { tipo?: string }>(req);
    const { limite, desplazamiento } = limitesPaginacion(p);
    const condiciones = ['1 = 1'];
    const params: unknown[] = [];

    if (p.tipo) {
      condiciones.push('r.tipo = ?');
      params.push(p.tipo);
    }
    if (p.buscar) {
      condiciones.push('r.nombre LIKE ?');
      params.push(`%${p.buscar}%`);
    }

    const donde = condiciones.join(' AND ');
    const filas = await query(
      `SELECT r.*, u.nombre AS usuario FROM reportes r
         LEFT JOIN usuarios u ON u.id_usuario = r.id_usuario
        WHERE ${donde} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );
    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM reportes r WHERE ${donde}`,
      params,
    );
    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

reportesRouter.get(
  '/:id',
  requierePermiso(PERMISOS.REPORTES_VER),
  asyncHandler(async (req, res) => {
    const fila = await queryOne<{ parametros: unknown }>(
      `SELECT r.*, u.nombre AS usuario FROM reportes r
         LEFT JOIN usuarios u ON u.id_usuario = r.id_usuario WHERE r.id_reporte = ?`,
      [Number(req.params.id)],
    );
    if (!fila) throw errores.noEncontrado('el reporte solicitado');
    ok(res, fila);
  }),
);

// ---------------------------------------------------------------------------
// GET /reports/:id/export?formato=pdf|csv|xlsx
// ---------------------------------------------------------------------------
reportesRouter.get(
  '/:id/export',
  requierePermiso(PERMISOS.REPORTES_EXPORTAR),
  validarConsulta(z.object({ formato: z.enum(['pdf', 'csv', 'xlsx']).default('pdf') })),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { formato } = consulta<{ formato: 'pdf' | 'csv' | 'xlsx' }>(req);

    const guardado = await queryOne<{ parametros: string | object; nombre: string }>(
      'SELECT parametros, nombre FROM reportes WHERE id_reporte = ?',
      [id],
    );
    if (!guardado) throw errores.noEncontrado('el reporte solicitado');

    const parametros = (
      typeof guardado.parametros === 'string' ? JSON.parse(guardado.parametros) : guardado.parametros
    ) as ParametrosReporte;

    const reporte = await construirReporte(parametros, req.usuario!.nombre);
    const encabezado = encabezadoDelReporte(reporte);
    const indicadores = indicadoresDelReporte(reporte);
    const tablas = tablasDelReporte(reporte);
    const nombreArchivo = `reporte_${id}_${parametros.tipo.toLowerCase()}`;

    await auditarDesdeRequest(req, {
      accion: 'REPORTE_EXPORTADO',
      entidad: 'reportes',
      idEntidad: id,
      despues: { formato },
    });

    if (formato === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}.csv"`);
      res.send(generarCsv(tablas[0]));
      return;
    }

    if (formato === 'xlsx') {
      const buffer = await generarXlsx(encabezado, indicadores, tablas);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}.xlsx"`);
      res.send(buffer);
      return;
    }

    const pdf = await generarPdf(encabezado, indicadores, tablas);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nombreArchivo}.pdf"`);
    res.send(pdf);
  }),
);
