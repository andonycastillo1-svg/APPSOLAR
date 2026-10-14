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
import { MESES_ES, formatoLargoEs, hoyISO, periodoAnterior } from '../../utils/fechas';
import { SUBCONSULTA_PANELES } from '../grupos/grupos.routes';
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

// ---------------------------------------------------------------------------
// GET /reports/inventory/export?id_cliente=&solo_activos=1
//
// Inventario (stock) de proyectos en Excel: cuantos proyectos, grupos,
// inversores y paneles hay en total, y todo lo que lleva cada proyecto.
// La produccion acumulada respeta la precedencia de niveles (sin doble conteo).
// ---------------------------------------------------------------------------
reportesRouter.get(
  '/inventory/export',
  requierePermiso(PERMISOS.REPORTES_EXPORTAR),
  validarConsulta(
    z.object({
      id_cliente: z.coerce.number().int().positive().optional(),
      solo_activos: z.enum(['1', '0']).default('0'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { id_cliente: idCliente, solo_activos: soloActivos } = consulta<{
      id_cliente?: number;
      solo_activos: '1' | '0';
    }>(req);

    const condiciones = ['1 = 1'];
    const params: unknown[] = [];
    if (idCliente) {
      condiciones.push('pr.id_cliente = ?');
      params.push(idCliente);
    }
    if (soloActivos === '1') condiciones.push('pr.activo = 1');
    const donde = condiciones.join(' AND ');

    const proyectos = await query<{
      id_proyecto: number;
      proyecto: string;
      cliente: string;
      nit: string;
      ubicacion: string | null;
      tipo_proyecto: string;
      suministradora: string | null;
      tipo_tarifa: string | null;
      valor_pactado_kwh: number | null;
      capacidad_kwp: number | null;
      fecha_inicio: string | null;
      activo: number;
    }>(
      `SELECT pr.id_proyecto, pr.nombre AS proyecto, c.nombre AS cliente, c.nit, pr.ubicacion,
              pr.tipo_proyecto, pr.suministradora, tt.sigla AS tipo_tarifa, pr.valor_pactado_kwh,
              pr.capacidad_kwp, pr.fecha_inicio, pr.activo
         FROM proyectos pr
         JOIN clientes c ON c.id_cliente = pr.id_cliente
         LEFT JOIN tipos_tarifa tt ON tt.id_tipo_tarifa = pr.id_tipo_tarifa
        WHERE ${donde}
        ORDER BY c.nombre, pr.nombre`,
      params,
    );
    const ids = proyectos.map((p) => p.id_proyecto);
    const enLista = ids.length ? ids.map(() => '?').join(',') : 'NULL';

    const grupos = await query<{
      id_grupo: number;
      id_proyecto: number;
      grupo: string;
      cantidad_inversores_declarada: number | null;
      inversores_registrados: number;
      tiene_banco_baterias: number;
      capacidad_baterias_kwh: number | null;
      capacidad_kwp: number | null;
      cantidad_paneles: number;
      capacidad_paneles_kwp: number;
      origen_paneles: string;
      activo: number;
    }>(
      `SELECT g.id_grupo, g.id_proyecto, g.nombre AS grupo, g.cantidad_inversores_declarada,
              (SELECT COUNT(*) FROM inversores i WHERE i.id_grupo = g.id_grupo AND i.activo = 1) AS inversores_registrados,
              g.tiene_banco_baterias, g.capacidad_baterias_kwh, g.capacidad_kwp, g.activo,
              ${SUBCONSULTA_PANELES}
         FROM grupos g WHERE g.id_proyecto IN (${enLista}) ORDER BY g.id_proyecto, g.nombre`,
      ids,
    );

    const inversores = await query<{
      id_inversor: number;
      id_proyecto: number;
      id_grupo: number;
      marca: string;
      modelo: string;
      tipo_conexion: string;
      serial_externo: string | null;
      capacidad_kwp: number | null;
      cantidad_paneles: number | null;
      potencia_panel_wp: number | null;
      estado: string;
      activo: number;
    }>(
      `SELECT id_inversor, id_proyecto, id_grupo, marca, modelo, tipo_conexion, serial_externo,
              capacidad_kwp, cantidad_paneles, potencia_panel_wp, estado, activo
         FROM inversores WHERE id_proyecto IN (${enLista}) ORDER BY id_proyecto, id_grupo, marca, modelo`,
      ids,
    );

    const lotes = await query<{
      id_proyecto: number;
      grupo: string;
      cantidad: number;
      potencia_wp: number;
      marca: string | null;
      modelo: string | null;
      fecha_instalacion: string | null;
    }>(
      `SELECT g.id_proyecto, g.nombre AS grupo, l.cantidad, l.potencia_wp, l.marca, l.modelo, l.fecha_instalacion
         FROM paneles_grupo l JOIN grupos g ON g.id_grupo = l.id_grupo
        WHERE l.activo = 1 AND g.id_proyecto IN (${enLista})
        ORDER BY g.id_proyecto, g.nombre, l.fecha_instalacion`,
      ids,
    );

    // Produccion acumulada sin doble conteo, por proyecto y por grupo.
    const filtroProduccion = { desde: '2000-01-01', hasta: hoyISO(), idCliente: idCliente ?? null };
    const produccionProyecto = new Map(
      (await consultas.porProyecto(filtroProduccion)).map((p) => [p.id_proyecto, p]),
    );
    const produccionGrupo = new Map(
      (await consultas.porGrupo(filtroProduccion)).map((g) => [g.id_grupo, g]),
    );
    const produccionInversor = new Map(
      (await consultas.porInversor(filtroProduccion)).map((i) => [i.id_inversor, i]),
    );

    const tarifasVigentes = await query<{
      id_proyecto: number;
      anio: number;
      trimestre: number;
      costo_kwh: number;
      estado: string;
      origen: string;
    }>(
      `SELECT t.id_proyecto, t.anio, t.trimestre, t.costo_kwh, t.estado, t.origen
         FROM tarifas_kwh t
        WHERE t.estado <> 'ANULADA' AND t.id_proyecto IN (${enLista})
        ORDER BY t.id_proyecto, t.anio DESC, t.trimestre DESC`,
      ids,
    );

    const nombreProyecto = new Map(proyectos.map((p) => [p.id_proyecto, p.proyecto]));
    const nombreGrupo = new Map(grupos.map((g) => [g.id_grupo, g.grupo]));
    const gruposDe = (id: number) => grupos.filter((g) => g.id_proyecto === id && g.activo);
    const inversoresDe = (id: number) => inversores.filter((i) => i.id_proyecto === id && i.activo);

    const filasProyectos = proyectos.map((p) => {
      const gs = gruposDe(p.id_proyecto);
      const prod = produccionProyecto.get(p.id_proyecto);
      return {
        cliente: p.cliente,
        nit: p.nit,
        proyecto: p.proyecto,
        ubicacion: p.ubicacion ?? '',
        modalidad: p.tipo_proyecto,
        suministradora: p.suministradora ?? '',
        tipo_tarifa: p.tipo_tarifa ?? '',
        valor_pactado: p.valor_pactado_kwh === null ? '' : Number(p.valor_pactado_kwh),
        potencia_kwp: Number(p.capacidad_kwp ?? 0),
        grupos: gs.length,
        inversores: inversoresDe(p.id_proyecto).length,
        paneles: gs.reduce((a, g) => a + Number(g.cantidad_paneles), 0),
        potencia_paneles_kwp: redondear(gs.reduce((a, g) => a + Number(g.capacidad_paneles_kwp), 0), 3),
        produccion_kwh: Number(prod?.kwh ?? 0),
        valor_q: Number(prod?.valor_q ?? 0),
        pendientes: Number(prod?.pendientes ?? 0),
        inicio: p.fecha_inicio ? String(p.fecha_inicio).slice(0, 10) : '',
        estado: p.activo ? 'Activo' : 'Inactivo',
      };
    });

    const suma = (clave: keyof (typeof filasProyectos)[number]) =>
      redondear(filasProyectos.reduce((a, f) => a + Number(f[clave] || 0), 0), 4);
    const totales = {
      clientes: new Set(proyectos.map((p) => p.nit)).size,
      proyectos: proyectos.length,
      grupos: filasProyectos.reduce((a, f) => a + f.grupos, 0),
      inversores: filasProyectos.reduce((a, f) => a + f.inversores, 0),
      paneles: filasProyectos.reduce((a, f) => a + f.paneles, 0),
      potencia: suma('potencia_kwp'),
      potenciaPaneles: suma('potencia_paneles_kwp'),
      kwh: suma('produccion_kwh'),
      valor: suma('valor_q'),
      pendientes: filasProyectos.reduce((a, f) => a + f.pendientes, 0),
    };

    const tablaProyectos: TablaReporte = {
      titulo: 'Proyectos',
      columnas: [
        { clave: 'cliente', titulo: 'Cliente', ancho: 30 },
        { clave: 'nit', titulo: 'NIT', ancho: 14 },
        { clave: 'proyecto', titulo: 'Proyecto', ancho: 34 },
        { clave: 'ubicacion', titulo: 'Ubicacion', ancho: 26 },
        { clave: 'modalidad', titulo: 'Modalidad', ancho: 11 },
        { clave: 'suministradora', titulo: 'Suministradora', ancho: 18 },
        { clave: 'tipo_tarifa', titulo: 'Tipo de tarifa', ancho: 13 },
        { clave: 'valor_pactado', titulo: 'Valor pactado (Q/kWh)', ancho: 20 },
        { clave: 'potencia_kwp', titulo: 'Potencia (kWp)', ancho: 15 },
        { clave: 'grupos', titulo: 'Grupos', ancho: 9 },
        { clave: 'inversores', titulo: 'Inversores', ancho: 11 },
        { clave: 'paneles', titulo: 'Paneles', ancho: 10 },
        { clave: 'potencia_paneles_kwp', titulo: 'Potencia paneles (kWp)', ancho: 21 },
        { clave: 'produccion_kwh', titulo: 'Produccion acumulada (kWh)', ancho: 25 },
        { clave: 'valor_q', titulo: 'Valor acumulado (Q)', ancho: 19 },
        { clave: 'pendientes', titulo: 'Registros sin tarifa', ancho: 18 },
        { clave: 'inicio', titulo: 'Inicio de operacion', ancho: 18 },
        { clave: 'estado', titulo: 'Estado', ancho: 10 },
      ],
      filas: [
        ...filasProyectos,
        {
          cliente: 'TOTAL',
          proyecto: `${totales.proyectos} proyecto(s)`,
          potencia_kwp: totales.potencia,
          grupos: totales.grupos,
          inversores: totales.inversores,
          paneles: totales.paneles,
          potencia_paneles_kwp: totales.potenciaPaneles,
          produccion_kwh: totales.kwh,
          valor_q: totales.valor,
          pendientes: totales.pendientes,
        },
      ],
    };

    const tablaGrupos: TablaReporte = {
      titulo: 'Grupos',
      columnas: [
        { clave: 'proyecto', titulo: 'Proyecto', ancho: 34 },
        { clave: 'grupo', titulo: 'Grupo', ancho: 26 },
        { clave: 'declarados', titulo: 'Inversores declarados', ancho: 20 },
        { clave: 'registrados', titulo: 'Inversores registrados', ancho: 21 },
        { clave: 'baterias', titulo: 'Banco de baterias', ancho: 17 },
        { clave: 'baterias_kwh', titulo: 'Baterias (kWh)', ancho: 15 },
        { clave: 'potencia_kwp', titulo: 'Potencia (kWp)', ancho: 15 },
        { clave: 'paneles', titulo: 'Paneles', ancho: 10 },
        { clave: 'origen_paneles', titulo: 'Origen de paneles', ancho: 17 },
        { clave: 'potencia_paneles_kwp', titulo: 'Potencia paneles (kWp)', ancho: 21 },
        { clave: 'produccion_kwh', titulo: 'Produccion acumulada (kWh)', ancho: 25 },
        { clave: 'estado', titulo: 'Estado', ancho: 10 },
      ],
      filas: grupos.map((g) => ({
        proyecto: nombreProyecto.get(g.id_proyecto) ?? '',
        grupo: g.grupo,
        declarados: g.cantidad_inversores_declarada ?? '',
        registrados: Number(g.inversores_registrados),
        baterias: g.tiene_banco_baterias ? 'Si' : 'No',
        baterias_kwh: g.capacidad_baterias_kwh === null ? '' : Number(g.capacidad_baterias_kwh),
        potencia_kwp: g.capacidad_kwp === null ? '' : Number(g.capacidad_kwp),
        paneles: Number(g.cantidad_paneles),
        origen_paneles: g.origen_paneles === 'INVERSORES' ? 'Inversores' : 'Lotes del grupo',
        potencia_paneles_kwp: redondear(Number(g.capacidad_paneles_kwp), 3),
        produccion_kwh: Number(produccionGrupo.get(g.id_grupo)?.kwh ?? 0),
        estado: g.activo ? 'Activo' : 'Inactivo',
      })),
    };

    const tablaInversores: TablaReporte = {
      titulo: 'Inversores',
      columnas: [
        { clave: 'proyecto', titulo: 'Proyecto', ancho: 34 },
        { clave: 'grupo', titulo: 'Grupo', ancho: 24 },
        { clave: 'marca', titulo: 'Marca', ancho: 14 },
        { clave: 'modelo', titulo: 'Modelo', ancho: 22 },
        { clave: 'conexion', titulo: 'Conexion', ancho: 13 },
        { clave: 'serie', titulo: 'Numero de serie', ancho: 22 },
        { clave: 'potencia_kwp', titulo: 'Potencia (kWp)', ancho: 15 },
        { clave: 'paneles', titulo: 'Paneles', ancho: 10 },
        { clave: 'wp_panel', titulo: 'Potencia por panel (Wp)', ancho: 22 },
        { clave: 'potencia_paneles_kwp', titulo: 'Potencia paneles (kWp)', ancho: 21 },
        { clave: 'produccion_kwh', titulo: 'Produccion acumulada (kWh)', ancho: 25 },
        { clave: 'estado', titulo: 'Estado', ancho: 15 },
      ],
      filas: inversores.map((i) => ({
        proyecto: nombreProyecto.get(i.id_proyecto) ?? '',
        grupo: nombreGrupo.get(i.id_grupo) ?? '',
        marca: i.marca,
        modelo: i.modelo,
        conexion: i.tipo_conexion,
        serie: i.serial_externo ?? '',
        potencia_kwp: i.capacidad_kwp === null ? '' : Number(i.capacidad_kwp),
        paneles: i.cantidad_paneles ?? '',
        wp_panel: i.potencia_panel_wp === null ? '' : Number(i.potencia_panel_wp),
        potencia_paneles_kwp:
          i.cantidad_paneles && i.potencia_panel_wp
            ? redondear((i.cantidad_paneles * Number(i.potencia_panel_wp)) / 1000, 3)
            : '',
        produccion_kwh: Number(produccionInversor.get(i.id_inversor)?.kwh ?? 0),
        estado: i.activo ? i.estado : 'INACTIVO',
      })),
    };

    const tablaLotes: TablaReporte = {
      titulo: 'Lotes de paneles',
      columnas: [
        { clave: 'proyecto', titulo: 'Proyecto', ancho: 34 },
        { clave: 'grupo', titulo: 'Grupo', ancho: 24 },
        { clave: 'cantidad', titulo: 'Cantidad', ancho: 11 },
        { clave: 'wp', titulo: 'Potencia por panel (Wp)', ancho: 22 },
        { clave: 'kwp', titulo: 'Potencia del lote (kWp)', ancho: 22 },
        { clave: 'marca', titulo: 'Marca', ancho: 16 },
        { clave: 'modelo', titulo: 'Modelo', ancho: 20 },
        { clave: 'fecha', titulo: 'Instalacion', ancho: 14 },
      ],
      filas: lotes.map((l) => ({
        proyecto: nombreProyecto.get(l.id_proyecto) ?? '',
        grupo: l.grupo,
        cantidad: Number(l.cantidad),
        wp: Number(l.potencia_wp),
        kwp: redondear((Number(l.cantidad) * Number(l.potencia_wp)) / 1000, 3),
        marca: l.marca ?? '',
        modelo: l.modelo ?? '',
        fecha: l.fecha_instalacion ? String(l.fecha_instalacion).slice(0, 10) : '',
      })),
    };

    const tablaTarifas: TablaReporte = {
      titulo: 'Tarifas',
      columnas: [
        { clave: 'proyecto', titulo: 'Proyecto', ancho: 34 },
        { clave: 'anio', titulo: 'Anio tarifario', ancho: 14 },
        { clave: 'trimestre', titulo: 'Trimestre', ancho: 12 },
        { clave: 'costo', titulo: 'Tarifa (Q/kWh)', ancho: 15 },
        { clave: 'estado', titulo: 'Estado', ancho: 13 },
        { clave: 'origen', titulo: 'Origen', ancho: 20 },
      ],
      filas: tarifasVigentes.map((t) => ({
        proyecto: nombreProyecto.get(t.id_proyecto) ?? '',
        anio: t.anio,
        trimestre: ['I', 'II', 'III', 'IV'][t.trimestre - 1] ?? String(t.trimestre),
        costo: Number(t.costo_kwh),
        estado: t.estado,
        origen: t.origen,
      })),
    };

    const filtros: Array<{ etiqueta: string; valor: string }> = [
      { etiqueta: 'Proyectos incluidos', valor: soloActivos === '1' ? 'Solo activos' : 'Todos (activos e inactivos)' },
    ];
    if (idCliente) {
      const cliente = await queryOne<{ nombre: string }>('SELECT nombre FROM clientes WHERE id_cliente = ?', [idCliente]);
      filtros.push({ etiqueta: 'Cliente', valor: cliente?.nombre ?? String(idCliente) });
    }

    const empresa = await obtenerTexto('empresa.nombre', 'Retse, S.A.');
    const buffer = await generarXlsx(
      {
        titulo: 'Inventario de proyectos',
        subtitulo: `Stock total a ${formatoLargoEs(hoyISO())}`,
        empresa,
        usuario: req.usuario!.nombre,
        filtros,
        notas: [
          'La produccion acumulada respeta la precedencia por inversor, grupo y proyecto: nunca se suma dos veces.',
          'Los paneles de un grupo salen de sus inversores; si ninguno los tiene registrados, de los lotes del grupo.',
          'Potencia en kWp (instalada) y energia en kWh. Valores en quetzales (GTQ).',
        ],
      },
      [
        { etiqueta: 'Clientes', valor: String(totales.clientes) },
        { etiqueta: 'Proyectos', valor: String(totales.proyectos) },
        { etiqueta: 'Grupos', valor: String(totales.grupos) },
        { etiqueta: 'Inversores', valor: String(totales.inversores) },
        { etiqueta: 'Paneles instalados', valor: formatoNumero(totales.paneles, 0) },
        { etiqueta: 'Potencia instalada total', valor: `${formatoNumero(totales.potencia, 2)} kWp` },
        { etiqueta: 'Potencia en paneles', valor: `${formatoNumero(totales.potenciaPaneles, 2)} kWp` },
        { etiqueta: 'Produccion acumulada', valor: `${formatoNumero(totales.kwh, 2)} kWh` },
        { etiqueta: 'Valor acumulado', valor: formatoQ(totales.valor) },
        { etiqueta: 'Registros pendientes de tarifa', valor: String(totales.pendientes) },
      ],
      [tablaProyectos, tablaGrupos, tablaInversores, tablaLotes, tablaTarifas],
    );

    await auditarDesdeRequest(req, {
      accion: 'REPORTE_EXPORTADO',
      entidad: 'reportes',
      idEntidad: 'inventario',
      despues: { formato: 'xlsx', tipo: 'INVENTARIO_PROYECTOS', proyectos: totales.proyectos },
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="inventario_proyectos_${hoyISO()}.xlsx"`);
    res.send(buffer);
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
