import { query, queryOne } from '../db/pool';
import { redondear, porcentajeCumplimiento, variacionPorcentual } from '../utils/numeros';
import { MESES_ES } from '../utils/fechas';

/**
 * Consultas agregadas de produccion.
 *
 * PREVENCION DE DOBLE CONTEO (regla 10 del alcance):
 * Para un mismo proyecto/anio/mes la produccion puede existir como
 * `PROYECTO_CONSOLIDADO` (una sola cifra mensual de la planta) o como
 * `POR_INVERSOR` (detalle por dispositivo). Sumar ambos duplicaria la energia.
 *
 * La CTE `niveles` decide, por cada proyecto/anio/mes, cual nivel prevalece:
 * si existe al menos un registro POR_INVERSOR, el consolidado de ese periodo se
 * ignora en los totales. La bandera se expone en las consultas para que la
 * interfaz pueda advertirlo.
 */

export interface FiltrosProduccion {
  desde: string;
  hasta: string;
  idCliente?: number | null;
  idProyecto?: number | null;
  idGrupo?: number | null;
  idInversor?: number | null;
  idsInversores?: number[] | null;
}

interface Fragmento {
  donde: string;
  params: unknown[];
}

const CTE_NIVELES = `
WITH niveles_grupo AS (
  -- Dentro de CADA grupo y para CADA FECHA: se sabe si hay detalle por inversor.
  --
  -- La resolucion es por fecha y no por mes a proposito: cuando un grupo pierde
  -- la conexion unos dias y esos dias se cargan manualmente como consolidado
  -- del grupo, esos registros DEBEN sumarse aunque el resto del mes si tenga
  -- detalle por inversor. Resolver por mes los descartaria y se perderia
  -- informacion real.
  SELECT id_proyecto, grupo_key, fecha,
         MAX(nivel_detalle = 'POR_INVERSOR') AS tiene_inversor
    FROM produccion
   WHERE activo = 1
   GROUP BY id_proyecto, grupo_key, fecha
),
niveles_proyecto AS (
  -- Para CADA proyecto y fecha: se sabe si existe algun dato a nivel de grupo.
  SELECT id_proyecto, fecha,
         MAX(id_grupo IS NOT NULL) AS tiene_grupo
    FROM produccion
   WHERE activo = 1
   GROUP BY id_proyecto, fecha
),
granularidades AS (
  -- Para cada equipo o grupo: se sabe si hay lecturas diarias en el mes.
  SELECT id_proyecto, grupo_key, inversor_key, anio, mes,
         MAX(granularidad = 'DIARIA') AS tiene_diaria
    FROM produccion
   WHERE activo = 1
   GROUP BY id_proyecto, grupo_key, inversor_key, anio, mes
)`;

/**
 * Condicion que descarta el nivel de detalle redundante.
 *
 * Precedencia:  POR_INVERSOR  >  GRUPO_CONSOLIDADO  >  PROYECTO_CONSOLIDADO
 *
 * La resolucion se hace POR GRUPO, no por proyecto. Si el grupo A tiene
 * detalle por inversor y el grupo B solo su consolidado (porque perdio la
 * conexion con Huawei y se cargo manualmente), AMBOS se suman: descartar B
 * perderia informacion real.
 *
 * El consolidado de proyecto solo interviene cuando el mes no tiene ningun
 * dato a nivel de grupo.
 */
const SIN_DOBLE_CONTEO = `
  (
    (p.id_grupo IS NOT NULL AND ng.tiene_inversor = 1 AND p.nivel_detalle = 'POR_INVERSOR')
    OR
    (p.id_grupo IS NOT NULL AND ng.tiene_inversor = 0 AND p.nivel_detalle = 'GRUPO_CONSOLIDADO')
    OR
    (p.id_grupo IS NULL AND np.tiene_grupo = 0 AND p.nivel_detalle = 'PROYECTO_CONSOLIDADO')
  )`;

/**
 * Condicion equivalente para la granularidad: si un equipo o grupo tiene
 * lecturas DIARIAS en un mes, el cierre MENSUAL de ese mismo mes no se suma
 * (seria el mismo dato agregado dos veces).
 */
const SIN_MEZCLA_GRANULARIDAD = `
  ((g.tiene_diaria = 1 AND p.granularidad = 'DIARIA')
    OR (g.tiene_diaria = 0 AND p.granularidad = 'MENSUAL'))`;

const JOIN_BASE = `
  FROM produccion p
  JOIN niveles_grupo ng ON ng.id_proyecto = p.id_proyecto AND ng.grupo_key = p.grupo_key
                       AND ng.fecha = p.fecha
  JOIN niveles_proyecto np ON np.id_proyecto = p.id_proyecto
                          AND np.fecha = p.fecha
  JOIN granularidades g ON g.id_proyecto = p.id_proyecto AND g.grupo_key = p.grupo_key
                       AND g.inversor_key = p.inversor_key
                       AND g.anio = p.anio AND g.mes = p.mes
  JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
  JOIN clientes c ON c.id_cliente = pr.id_cliente
  LEFT JOIN grupos gr ON gr.id_grupo = p.id_grupo
  LEFT JOIN inversores i ON i.id_inversor = p.id_inversor`;

function construirFiltros(f: FiltrosProduccion, aplicarNivel = true): Fragmento {
  const condiciones: string[] = ['p.activo = 1', 'p.fecha BETWEEN ? AND ?'];
  const params: unknown[] = [f.desde, f.hasta];

  if (aplicarNivel) condiciones.push(SIN_DOBLE_CONTEO, SIN_MEZCLA_GRANULARIDAD);
  if (f.idCliente) {
    condiciones.push('pr.id_cliente = ?');
    params.push(f.idCliente);
  }
  if (f.idProyecto) {
    condiciones.push('p.id_proyecto = ?');
    params.push(f.idProyecto);
  }
  if (f.idGrupo) {
    condiciones.push('p.id_grupo = ?');
    params.push(f.idGrupo);
  }
  if (f.idInversor) {
    condiciones.push('p.id_inversor = ?');
    params.push(f.idInversor);
  }
  if (f.idsInversores && f.idsInversores.length > 0) {
    condiciones.push(`p.id_inversor IN (${f.idsInversores.map(() => '?').join(',')})`);
    params.push(...f.idsInversores);
  }

  return { donde: condiciones.join(' AND '), params };
}

export interface ResumenProduccion {
  kwh: number;
  valor_q: number;
  registros: number;
  registrosPendientes: number;
  kwhPendientes: number;
  primeraFecha: string | null;
  ultimaFecha: string | null;
}

export async function resumen(f: FiltrosProduccion): Promise<ResumenProduccion> {
  const { donde, params } = construirFiltros(f);
  const fila = await queryOne<{
    kwh: number;
    valor_q: number;
    registros: number;
    pendientes: number;
    kwh_pendientes: number;
    primera: string | null;
    ultima: string | null;
  }>(
    `${CTE_NIVELES}
     SELECT COALESCE(SUM(p.kwh), 0) AS kwh,
            COALESCE(SUM(p.valor_q), 0) AS valor_q,
            COUNT(*) AS registros,
            COALESCE(SUM(p.estado_valorizacion = 'PENDIENTE_DE_TARIFA'), 0) AS pendientes,
            COALESCE(SUM(CASE WHEN p.estado_valorizacion = 'PENDIENTE_DE_TARIFA' THEN p.kwh ELSE 0 END), 0) AS kwh_pendientes,
            MIN(p.fecha) AS primera, MAX(p.fecha) AS ultima
       ${JOIN_BASE}
      WHERE ${donde}`,
    params,
  );

  return {
    kwh: redondear(Number(fila?.kwh ?? 0), 4),
    valor_q: redondear(Number(fila?.valor_q ?? 0), 4),
    registros: Number(fila?.registros ?? 0),
    registrosPendientes: Number(fila?.pendientes ?? 0),
    kwhPendientes: redondear(Number(fila?.kwh_pendientes ?? 0), 4),
    primeraFecha: fila?.primera ?? null,
    ultimaFecha: fila?.ultima ?? null,
  };
}

export type Granularidad = 'DIARIA' | 'MENSUAL' | 'ANUAL';

export interface PuntoSerie {
  periodo: string;
  etiqueta: string;
  kwh: number;
  valor_q: number;
  pendientes: number;
}

export async function serieTemporal(
  f: FiltrosProduccion,
  granularidad: Granularidad,
): Promise<PuntoSerie[]> {
  const { donde, params } = construirFiltros(f);

  const expresion =
    granularidad === 'DIARIA'
      ? 'DATE_FORMAT(p.fecha, "%Y-%m-%d")'
      : granularidad === 'MENSUAL'
        ? 'DATE_FORMAT(p.fecha, "%Y-%m")'
        : 'DATE_FORMAT(p.fecha, "%Y")';

  const filas = await query<{ periodo: string; kwh: number; valor_q: number; pendientes: number }>(
    `${CTE_NIVELES}
     SELECT ${expresion} AS periodo,
            COALESCE(SUM(p.kwh), 0) AS kwh,
            COALESCE(SUM(p.valor_q), 0) AS valor_q,
            COALESCE(SUM(p.estado_valorizacion = 'PENDIENTE_DE_TARIFA'), 0) AS pendientes
       ${JOIN_BASE}
      WHERE ${donde}
      GROUP BY periodo ORDER BY periodo`,
    params,
  );

  return filas.map((fila) => ({
    periodo: fila.periodo,
    etiqueta: etiquetaPeriodo(fila.periodo, granularidad),
    kwh: redondear(Number(fila.kwh), 4),
    valor_q: redondear(Number(fila.valor_q), 4),
    pendientes: Number(fila.pendientes),
  }));
}

function etiquetaPeriodo(periodo: string, granularidad: Granularidad): string {
  if (granularidad === 'DIARIA') {
    const [a, m, d] = periodo.split('-');
    return `${d}/${m}/${a}`;
  }
  if (granularidad === 'MENSUAL') {
    const [a, m] = periodo.split('-');
    return `${MESES_ES[Number(m) - 1]} ${a}`;
  }
  return periodo;
}

export interface AgrupacionProyecto {
  id_proyecto: number;
  proyecto: string;
  cliente: string;
  tipo_proyecto: string;
  kwh: number;
  valor_q: number;
  pendientes: number;
  nivel_detalle: string;
}

export async function porProyecto(f: FiltrosProduccion): Promise<AgrupacionProyecto[]> {
  const { donde, params } = construirFiltros(f);
  const filas = await query<AgrupacionProyecto>(
    `${CTE_NIVELES}
     SELECT p.id_proyecto, pr.nombre AS proyecto, c.nombre AS cliente, pr.tipo_proyecto,
            COALESCE(SUM(p.kwh), 0) AS kwh,
            COALESCE(SUM(p.valor_q), 0) AS valor_q,
            COALESCE(SUM(p.estado_valorizacion = 'PENDIENTE_DE_TARIFA'), 0) AS pendientes,
            GROUP_CONCAT(DISTINCT p.nivel_detalle) AS nivel_detalle
       ${JOIN_BASE}
      WHERE ${donde}
      GROUP BY p.id_proyecto, pr.nombre, c.nombre, pr.tipo_proyecto
      ORDER BY kwh DESC`,
    params,
  );
  return filas.map((fila) => ({
    ...fila,
    kwh: redondear(Number(fila.kwh), 4),
    valor_q: redondear(Number(fila.valor_q), 4),
    pendientes: Number(fila.pendientes),
  }));
}

export interface AgrupacionInversor {
  id_inversor: number;
  inversor: string;
  proyecto: string;
  capacidad_kwp: number | null;
  kwh: number;
  valor_q: number;
  dias_con_datos: number;
  ultima_fecha: string | null;
}

/**
 * Agrupacion por inversor. Solo considera registros POR_INVERSOR: el
 * consolidado de proyecto no es atribuible a un dispositivo concreto.
 */
export async function porInversor(f: FiltrosProduccion): Promise<AgrupacionInversor[]> {
  const { donde, params } = construirFiltros(f, false);
  const filas = await query<AgrupacionInversor>(
    `${CTE_NIVELES}
     SELECT p.id_inversor,
            CONCAT(i.marca, ' ', i.modelo, COALESCE(CONCAT(' (', i.serial_externo, ')'), '')) AS inversor,
            pr.nombre AS proyecto, i.capacidad_kwp,
            COALESCE(SUM(p.kwh), 0) AS kwh,
            COALESCE(SUM(p.valor_q), 0) AS valor_q,
            COUNT(DISTINCT p.fecha) AS dias_con_datos,
            MAX(p.fecha) AS ultima_fecha
       FROM produccion p
       JOIN granularidades g ON g.id_proyecto = p.id_proyecto AND g.grupo_key = p.grupo_key
                            AND g.inversor_key = p.inversor_key
                            AND g.anio = p.anio AND g.mes = p.mes
       JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
       JOIN clientes c ON c.id_cliente = pr.id_cliente
       JOIN inversores i ON i.id_inversor = p.id_inversor
      WHERE ${donde} AND p.nivel_detalle = 'POR_INVERSOR' AND ${SIN_MEZCLA_GRANULARIDAD}
      GROUP BY p.id_inversor, i.marca, i.modelo, i.serial_externo, pr.nombre, i.capacidad_kwp
      ORDER BY kwh DESC`,
    params,
  );
  return filas.map((fila) => ({
    ...fila,
    kwh: redondear(Number(fila.kwh), 4),
    valor_q: redondear(Number(fila.valor_q), 4),
    dias_con_datos: Number(fila.dias_con_datos),
  }));
}

/**
 * Rendimiento relativo por inversor usando UNICAMENTE datos comparables:
 * se normaliza por potencia instalada (kWh/kWp) cuando esta disponible y por
 * dias con datos. Los inversores sin capacidad registrada se marcan como no
 * comparables en lugar de inventar una base.
 */
export async function rendimientoRelativo(f: FiltrosProduccion) {
  const inversores = await porInversor(f);
  const comparables = inversores.filter((i) => i.capacidad_kwp && i.capacidad_kwp > 0 && i.dias_con_datos > 0);

  const rendimientos = comparables.map((i) => ({
    ...i,
    kwh_por_kwp: redondear(i.kwh / Number(i.capacidad_kwp), 4),
    kwh_por_dia: redondear(i.kwh / i.dias_con_datos, 4),
  }));

  const promedio =
    rendimientos.length > 0
      ? rendimientos.reduce((acc, r) => acc + r.kwh_por_kwp, 0) / rendimientos.length
      : 0;

  return {
    comparables: rendimientos
      .map((r) => ({
        ...r,
        relativo: promedio > 0 ? redondear((r.kwh_por_kwp / promedio) * 100, 2) : null,
      }))
      .sort((a, b) => (a.relativo ?? 0) - (b.relativo ?? 0)),
    noComparables: inversores
      .filter((i) => !i.capacidad_kwp || i.capacidad_kwp <= 0)
      .map((i) => ({ ...i, razon: 'No tiene potencia instalada (kWp) registrada.' })),
    baseComparacion: 'Promedio de kWh/kWp del conjunto seleccionado en el mismo periodo.',
    promedioKwhPorKwp: redondear(promedio, 4),
  };
}

/** Comparacion contra el periodo anterior equivalente. */
export async function compararPeriodos(
  actual: FiltrosProduccion,
  anterior: FiltrosProduccion,
) {
  const [a, b] = await Promise.all([resumen(actual), resumen(anterior)]);
  return {
    actual: a,
    anterior: b,
    baseComparacion: `Periodo anterior equivalente (${anterior.desde} a ${anterior.hasta})`,
    variacion: {
      kwh_absoluta: redondear(a.kwh - b.kwh, 4),
      kwh_porcentual: variacionPorcentual(a.kwh, b.kwh),
      valor_absoluta: redondear(a.valor_q - b.valor_q, 4),
      valor_porcentual: variacionPorcentual(a.valor_q, b.valor_q),
    },
  };
}

// ---------------------------------------------------------------------------
// Resumen anual estilo Excel de referencia
// ---------------------------------------------------------------------------

export interface FilaResumenAnual {
  mes: number;
  mesNombre: string;
  trimestre: number;
  proyeccion_kwh: number | null;
  generacion_anio_anterior: number;
  cumplimiento_anio_anterior: number | null;
  generacion_anio_seleccionado: number;
  cumplimiento_anio_seleccionado: number | null;
  tarifa_q_kwh: number | null;
  estado_tarifa: string | null;
  valor_producido_q: number | null;
  pendiente_de_tarifa: boolean;
  comentarios: string | null;
}

export async function resumenAnual(
  anio: number,
  idProyecto?: number | null,
  idCliente?: number | null,
): Promise<{ filas: FilaResumenAnual[]; totales: Record<string, number | null> }> {
  const condiciones = ['p.activo = 1'];
  const params: unknown[] = [];
  if (idProyecto) {
    condiciones.push('p.id_proyecto = ?');
    params.push(idProyecto);
  }
  if (idCliente) {
    condiciones.push('pr.id_cliente = ?');
    params.push(idCliente);
  }
  const filtroExtra = condiciones.join(' AND ');

  const produccion = await query<{
    anio: number;
    mes: number;
    kwh: number;
    valor_q: number;
    pendientes: number;
    comentarios: string | null;
  }>(
    `${CTE_NIVELES}
     SELECT p.anio, p.mes,
            COALESCE(SUM(p.kwh), 0) AS kwh,
            COALESCE(SUM(p.valor_q), 0) AS valor_q,
            COALESCE(SUM(p.estado_valorizacion = 'PENDIENTE_DE_TARIFA'), 0) AS pendientes,
            SUBSTRING(GROUP_CONCAT(DISTINCT NULLIF(p.comentarios, '') SEPARATOR ' | '), 1, 500) AS comentarios
       FROM produccion p
       JOIN niveles_grupo ng ON ng.id_proyecto = p.id_proyecto AND ng.grupo_key = p.grupo_key
                             AND ng.fecha = p.fecha
       JOIN niveles_proyecto np ON np.id_proyecto = p.id_proyecto
                               AND np.fecha = p.fecha
       JOIN granularidades g ON g.id_proyecto = p.id_proyecto AND g.grupo_key = p.grupo_key
                            AND g.inversor_key = p.inversor_key
                            AND g.anio = p.anio AND g.mes = p.mes
       JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
      WHERE ${filtroExtra} AND ${SIN_DOBLE_CONTEO} AND ${SIN_MEZCLA_GRANULARIDAD}
        AND p.anio IN (?, ?)
      GROUP BY p.anio, p.mes`,
    [...params, anio, anio - 1],
  );

  const proyecciones = idProyecto
    ? await query<{ mes: number; proyeccion_kwh: number }>(
        `SELECT mes, proyeccion_kwh FROM proyecciones_kwh
          WHERE id_proyecto = ? AND anio = ? AND estado = 'APROBADA'`,
        [idProyecto, anio],
      )
    : await query<{ mes: number; proyeccion_kwh: number }>(
        `SELECT pj.mes, SUM(pj.proyeccion_kwh) AS proyeccion_kwh
           FROM proyecciones_kwh pj JOIN proyectos pr ON pr.id_proyecto = pj.id_proyecto
          WHERE pj.anio = ? AND pj.estado = 'APROBADA' ${idCliente ? 'AND pr.id_cliente = ?' : ''}
          GROUP BY pj.mes`,
        idCliente ? [anio, idCliente] : [anio],
      );

  // La tarifa es trimestral: cada mes muestra la del trimestre al que pertenece.
  const tarifas = idProyecto
    ? await query<{ trimestre: number; costo_kwh: number; estado: string }>(
        `SELECT trimestre, costo_kwh, estado FROM tarifas_kwh
          WHERE id_proyecto = ? AND anio = ? AND estado <> 'ANULADA'`,
        [idProyecto, anio],
      )
    : [];

  const mapaProd = new Map(produccion.map((p) => [`${p.anio}-${p.mes}`, p]));
  const mapaProy = new Map(proyecciones.map((p) => [p.mes, Number(p.proyeccion_kwh)]));
  const mapaTar = new Map(tarifas.map((t) => [t.trimestre, t]));

  const filas: FilaResumenAnual[] = Array.from({ length: 12 }, (_, i) => {
    const mes = i + 1;
    const actual = mapaProd.get(`${anio}-${mes}`);
    const previo = mapaProd.get(`${anio - 1}-${mes}`);
    const proyeccion = mapaProy.get(mes) ?? null;
    const trimestre = Math.ceil(mes / 3);
    const tarifa = mapaTar.get(trimestre) ?? null;
    const genActual = redondear(Number(actual?.kwh ?? 0), 4);
    const genPrevio = redondear(Number(previo?.kwh ?? 0), 4);
    const pendiente = Number(actual?.pendientes ?? 0) > 0;

    return {
      mes,
      mesNombre: MESES_ES[i],
      proyeccion_kwh: proyeccion,
      generacion_anio_anterior: genPrevio,
      cumplimiento_anio_anterior: porcentajeCumplimiento(genPrevio, proyeccion),
      generacion_anio_seleccionado: genActual,
      cumplimiento_anio_seleccionado: porcentajeCumplimiento(genActual, proyeccion),
      trimestre,
      tarifa_q_kwh: tarifa && tarifa.estado === 'APROBADA' ? Number(tarifa.costo_kwh) : null,
      estado_tarifa: tarifa?.estado ?? null,
      valor_producido_q: pendiente ? null : redondear(Number(actual?.valor_q ?? 0), 4),
      pendiente_de_tarifa: pendiente,
      comentarios: actual?.comentarios ?? null,
    };
  });

  const sumar = (selector: (f: FilaResumenAnual) => number | null) =>
    filas.reduce((acc, f) => acc + (selector(f) ?? 0), 0);

  const totalProyeccion = sumar((f) => f.proyeccion_kwh);
  const totalActual = sumar((f) => f.generacion_anio_seleccionado);
  const totalPrevio = sumar((f) => f.generacion_anio_anterior);

  return {
    filas,
    totales: {
      proyeccion_kwh: redondear(totalProyeccion, 4),
      generacion_anio_anterior: redondear(totalPrevio, 4),
      generacion_anio_seleccionado: redondear(totalActual, 4),
      cumplimiento_anio_anterior: porcentajeCumplimiento(totalPrevio, totalProyeccion || null),
      cumplimiento_anio_seleccionado: porcentajeCumplimiento(totalActual, totalProyeccion || null),
      valor_producido_q: redondear(sumar((f) => f.valor_producido_q), 4),
      mesesPendientes: filas.filter((f) => f.pendiente_de_tarifa).length,
    },
  };
}

/** Detalle paginado de registros de produccion. */
export async function detalle(
  f: FiltrosProduccion,
  limite: number,
  desplazamiento: number,
  ordenColumna = 'p.fecha',
  direccion: 'ASC' | 'DESC' = 'DESC',
) {
  const { donde, params } = construirFiltros(f, false);
  const filas = await query(
    `SELECT p.id_produccion, p.id_proyecto, pr.nombre AS proyecto, c.nombre AS cliente,
            p.id_grupo, gr.nombre AS grupo,
            p.id_inversor, i.marca, i.modelo, i.serial_externo,
            p.nivel_detalle, p.fecha, p.anio, p.mes, p.granularidad, p.kwh, p.origen,
            p.secuencia, p.costo_kwh_aplicado, p.valor_q, p.estado_valorizacion,
            p.comentarios, p.id_historico, p.id_sync, p.created_at, p.updated_at
       FROM produccion p
       JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
       JOIN clientes c ON c.id_cliente = pr.id_cliente
       LEFT JOIN grupos gr ON gr.id_grupo = p.id_grupo
       LEFT JOIN inversores i ON i.id_inversor = p.id_inversor
      WHERE ${donde}
      ORDER BY ${ordenColumna} ${direccion}, p.id_produccion DESC
      LIMIT ? OFFSET ?`,
    [...params, limite, desplazamiento],
  );

  const total = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM produccion p
       JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
       JOIN clientes c ON c.id_cliente = pr.id_cliente
      WHERE ${donde}`,
    params,
  );

  return { filas, total: Number(total?.total ?? 0) };
}

/**
 * Periodos donde coexisten varios niveles de detalle (aviso operativo).
 * No es un error: ocurre, por ejemplo, cuando un grupo perdio la conexion y
 * su produccion se cargo consolidada mientras el resto llego por inversor.
 * El sistema resuelve la precedencia automaticamente, pero lo informa.
 */
export async function periodosConMezclaDeNiveles(f: FiltrosProduccion) {
  return query<{
    id_proyecto: number;
    proyecto: string;
    anio: number;
    mes: number;
    niveles: string;
  }>(
    `SELECT p.id_proyecto, pr.nombre AS proyecto, p.anio, p.mes,
            GROUP_CONCAT(DISTINCT p.nivel_detalle ORDER BY p.nivel_detalle) AS niveles
       FROM produccion p JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
      WHERE p.activo = 1 AND p.fecha BETWEEN ? AND ?
      GROUP BY p.id_proyecto, pr.nombre, p.anio, p.mes
     HAVING COUNT(DISTINCT p.nivel_detalle) > 1
      ORDER BY p.anio, p.mes`,
    [f.desde, f.hasta],
  );
}

export interface AgrupacionGrupo {
  id_grupo: number;
  grupo: string;
  proyecto: string;
  tiene_banco_baterias: number;
  capacidad_kwp: number | null;
  inversores_registrados: number;
  cantidad_inversores_declarada: number | null;
  kwh: number;
  valor_q: number;
  ultima_fecha: string | null;
}

/** Agrupacion por grupo de inversores, respetando la precedencia de niveles. */
export async function porGrupo(f: FiltrosProduccion): Promise<AgrupacionGrupo[]> {
  const { donde, params } = construirFiltros(f);
  const filas = await query<AgrupacionGrupo>(
    `${CTE_NIVELES}
     SELECT p.id_grupo, gr.nombre AS grupo, pr.nombre AS proyecto,
            gr.tiene_banco_baterias, gr.capacidad_kwp,
            gr.cantidad_inversores_declarada,
            (SELECT COUNT(*) FROM inversores inv
              WHERE inv.id_grupo = gr.id_grupo AND inv.activo = 1) AS inversores_registrados,
            COALESCE(SUM(p.kwh), 0) AS kwh,
            COALESCE(SUM(p.valor_q), 0) AS valor_q,
            MAX(p.fecha) AS ultima_fecha
       ${JOIN_BASE}
      WHERE ${donde} AND p.id_grupo IS NOT NULL
      GROUP BY p.id_grupo, gr.nombre, pr.nombre, gr.tiene_banco_baterias,
               gr.capacidad_kwp, gr.cantidad_inversores_declarada
      ORDER BY kwh DESC`,
    params,
  );
  return filas.map((fila) => ({
    ...fila,
    kwh: redondear(Number(fila.kwh), 4),
    valor_q: redondear(Number(fila.valor_q), 4),
    inversores_registrados: Number(fila.inversores_registrados),
  }));
}

/**
 * Detecta los rangos de fechas SIN datos de cada grupo dentro de un periodo.
 *
 * Es la base del requerimiento de carga manual: cuando un grupo pierde la
 * conexion con Huawei, el operador necesita ver exactamente que dias faltan
 * para completarlos a mano.
 */
export async function huecosDeDatos(
  f: FiltrosProduccion,
): Promise<Array<{
  id_grupo: number;
  grupo: string;
  id_proyecto: number;
  proyecto: string;
  dias_esperados: number;
  dias_con_datos: number;
  dias_faltantes: number;
  primera_fecha: string | null;
  ultima_fecha: string | null;
}>> {
  const condiciones: string[] = ['g.activo = 1', 'pr.activo = 1'];
  const params: unknown[] = [f.desde, f.hasta, f.desde, f.hasta];

  if (f.idProyecto) {
    condiciones.push('g.id_proyecto = ?');
    params.push(f.idProyecto);
  }
  if (f.idGrupo) {
    condiciones.push('g.id_grupo = ?');
    params.push(f.idGrupo);
  }
  if (f.idCliente) {
    condiciones.push('pr.id_cliente = ?');
    params.push(f.idCliente);
  }

  return query(
    `SELECT g.id_grupo, g.nombre AS grupo, pr.id_proyecto, pr.nombre AS proyecto,
            DATEDIFF(?, ?) + 1 AS dias_esperados,
            COUNT(DISTINCT p.fecha) AS dias_con_datos,
            GREATEST(0, (DATEDIFF(?, ?) + 1) - COUNT(DISTINCT p.fecha)) AS dias_faltantes,
            MIN(p.fecha) AS primera_fecha,
            MAX(p.fecha) AS ultima_fecha
       FROM grupos g
       JOIN proyectos pr ON pr.id_proyecto = g.id_proyecto
       LEFT JOIN produccion p
              ON p.id_grupo = g.id_grupo AND p.activo = 1
             AND p.granularidad = 'DIARIA'
             AND p.fecha BETWEEN ? AND ?
      WHERE ${condiciones.join(' AND ')}
      GROUP BY g.id_grupo, g.nombre, pr.id_proyecto, pr.nombre
     HAVING dias_faltantes > 0
      ORDER BY dias_faltantes DESC`,
    [f.hasta, f.desde, f.hasta, f.desde, f.desde, f.hasta, ...params.slice(4)],
  );
}
