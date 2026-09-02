import { execute, query, queryOne, type Executor, getPool } from '../db/pool';
import { calcularValorQ, redondear } from '../utils/numeros';
import { errores } from '../utils/errors';
import {
  diasRestantesDelTrimestre,
  etiquetaTrimestre,
  trimestreActual,
  trimestreDeMes,
  trimestreSiguiente,
  trimestresDelPeriodo,
} from '../utils/fechas';

/**
 * Motor de valorizacion monetaria.
 *
 * Reglas fundamentales:
 *  - La tarifa del kWh tiene vigencia TRIMESTRAL (trimestres calendario).
 *  - Cada registro de produccion se valoriza con la tarifa APROBADA del
 *    proyecto correspondiente al TRIMESTRE de su propia fecha.
 *  - Si el trimestre no tiene tarifa aprobada, los kWh se conservan intactos
 *    y el registro queda `PENDIENTE_DE_TARIFA`. Nunca se usa cero ni la
 *    tarifa del trimestre anterior de forma automatica.
 *  - Se guarda `id_tarifa` y una copia de `costo_kwh_aplicado` para trazabilidad.
 *  - En rangos multi-trimestre se valoriza registro por registro y luego se suma.
 */

export interface TarifaAprobada {
  id_tarifa: number;
  id_proyecto: number;
  anio: number;
  trimestre: number;
  costo_kwh: number;
  moneda: string;
}

export async function buscarTarifaAprobada(
  idProyecto: number,
  anio: number,
  trimestre: number,
  executor: Executor = getPool(),
): Promise<TarifaAprobada | null> {
  return queryOne<TarifaAprobada>(
    `SELECT id_tarifa, id_proyecto, anio, trimestre, costo_kwh, moneda
       FROM tarifas_kwh
      WHERE id_proyecto = ? AND anio = ? AND trimestre = ? AND estado = 'APROBADA'
      LIMIT 1`,
    [idProyecto, anio, trimestre],
    executor,
  );
}

/** Atajo cuando se conoce el mes: resuelve su trimestre calendario. */
export async function buscarTarifaDelMes(
  idProyecto: number,
  anio: number,
  mes: number,
  executor: Executor = getPool(),
): Promise<TarifaAprobada | null> {
  return buscarTarifaAprobada(idProyecto, anio, trimestreDeMes(mes), executor);
}

/** Cache por lote para no repetir consultas al valorizar muchos registros. */
export class CacheTarifas {
  private readonly mapa = new Map<string, TarifaAprobada | null>();

  constructor(private readonly executor: Executor = getPool()) {}

  async obtener(idProyecto: number, anio: number, mes: number): Promise<TarifaAprobada | null> {
    const trimestre = trimestreDeMes(mes);
    const clave = `${idProyecto}|${anio}|T${trimestre}`;
    if (!this.mapa.has(clave)) {
      this.mapa.set(clave, await buscarTarifaAprobada(idProyecto, anio, trimestre, this.executor));
    }
    return this.mapa.get(clave) ?? null;
  }

  /** Trimestres consultados que resultaron sin tarifa aprobada. */
  trimestresPendientes(): Array<{ anio: number; trimestre: number }> {
    const salida: Array<{ anio: number; trimestre: number }> = [];
    for (const [clave, valor] of this.mapa.entries()) {
      if (!valor) {
        const partes = clave.split('|');
        salida.push({ anio: Number(partes[1]), trimestre: Number(partes[2].replace('T', '')) });
      }
    }
    return salida;
  }
}

export interface ValorizacionCalculada {
  id_tarifa: number | null;
  costo_kwh_aplicado: number | null;
  valor_q: number | null;
  estado_valorizacion: 'VALORIZADA' | 'PENDIENTE_DE_TARIFA';
}

export async function calcularValorizacion(
  idProyecto: number,
  anio: number,
  mes: number,
  kwh: number,
  cache?: CacheTarifas,
  executor: Executor = getPool(),
): Promise<ValorizacionCalculada> {
  const tarifa = cache
    ? await cache.obtener(idProyecto, anio, mes)
    : await buscarTarifaDelMes(idProyecto, anio, mes, executor);

  if (!tarifa) {
    return {
      id_tarifa: null,
      costo_kwh_aplicado: null,
      valor_q: null,
      estado_valorizacion: 'PENDIENTE_DE_TARIFA',
    };
  }

  return {
    id_tarifa: tarifa.id_tarifa,
    costo_kwh_aplicado: tarifa.costo_kwh,
    valor_q: calcularValorQ(kwh, tarifa.costo_kwh),
    estado_valorizacion: 'VALORIZADA',
  };
}

/**
 * Valoriza los registros pendientes de un proyecto y trimestre.
 * Se invoca al registrar o aprobar una tarifa faltante. NO toca registros
 * que ya estaban valorizados.
 */
export async function recalcularPendientes(
  idProyecto: number,
  anio: number,
  trimestre: number,
  executor: Executor = getPool(),
): Promise<{ registros: number; kwh: number; valor: number }> {
  const tarifa = await buscarTarifaAprobada(idProyecto, anio, trimestre, executor);
  if (!tarifa) return { registros: 0, kwh: 0, valor: 0 };

  const pendientes = await query<{ id_produccion: number; kwh: number }>(
    `SELECT id_produccion, kwh
       FROM produccion
      WHERE id_proyecto = ? AND anio = ? AND CEIL(mes / 3) = ?
        AND activo = 1 AND estado_valorizacion = 'PENDIENTE_DE_TARIFA'`,
    [idProyecto, anio, trimestre],
    executor,
  );

  let totalKwh = 0;
  let totalValor = 0;

  for (const fila of pendientes) {
    const valor = calcularValorQ(fila.kwh, tarifa.costo_kwh);
    await execute(
      `UPDATE produccion
          SET id_tarifa = ?, costo_kwh_aplicado = ?, valor_q = ?,
              estado_valorizacion = 'VALORIZADA'
        WHERE id_produccion = ?`,
      [tarifa.id_tarifa, tarifa.costo_kwh, valor, fila.id_produccion],
      executor,
    );
    totalKwh += fila.kwh;
    totalValor += valor;
  }

  return {
    registros: pendientes.length,
    kwh: redondear(totalKwh, 4),
    valor: redondear(totalValor, 4),
  };
}

export interface ImpactoTarifa {
  id_tarifa: number;
  id_proyecto: number;
  anio: number;
  trimestre: number;
  etiqueta: string;
  costoActual: number;
  costoPropuesto: number;
  registrosAfectados: number;
  kwhAfectados: number;
  valorAnterior: number;
  valorNuevo: number;
  diferencia: number;
  mesesCerrados: number[];
}

/**
 * Analisis de impacto previo a corregir una tarifa ya utilizada.
 * Debe mostrarse al usuario antes de exigir motivo y confirmacion.
 */
export async function analizarImpacto(
  idTarifa: number,
  costoPropuesto: number,
  executor: Executor = getPool(),
): Promise<ImpactoTarifa> {
  const tarifa = await queryOne<{
    id_tarifa: number;
    id_proyecto: number;
    anio: number;
    trimestre: number;
    costo_kwh: number;
  }>(
    'SELECT id_tarifa, id_proyecto, anio, trimestre, costo_kwh FROM tarifas_kwh WHERE id_tarifa = ?',
    [idTarifa],
    executor,
  );
  if (!tarifa) throw errores.noEncontrado('la tarifa indicada');

  const resumen = await queryOne<{ registros: number; kwh: number; valor: number }>(
    `SELECT COUNT(*) AS registros,
            COALESCE(SUM(kwh), 0) AS kwh,
            COALESCE(SUM(valor_q), 0) AS valor
       FROM produccion
      WHERE id_tarifa = ? AND activo = 1`,
    [idTarifa],
    executor,
  );

  const kwh = Number(resumen?.kwh ?? 0);
  const valorAnterior = redondear(Number(resumen?.valor ?? 0), 4);
  const valorNuevo = redondear(kwh * costoPropuesto, 4);

  return {
    id_tarifa: tarifa.id_tarifa,
    id_proyecto: tarifa.id_proyecto,
    anio: tarifa.anio,
    trimestre: tarifa.trimestre,
    etiqueta: etiquetaTrimestre(tarifa.anio, tarifa.trimestre),
    costoActual: tarifa.costo_kwh,
    costoPropuesto,
    registrosAfectados: Number(resumen?.registros ?? 0),
    kwhAfectados: redondear(kwh, 4),
    valorAnterior,
    valorNuevo,
    diferencia: redondear(valorNuevo - valorAnterior, 4),
    mesesCerrados: await mesesCerradosDelTrimestre(
      tarifa.id_proyecto,
      tarifa.anio,
      tarifa.trimestre,
      executor,
    ),
  };
}

/** Recalcula todos los registros valorizados con una tarifa determinada. */
export async function recalcularPorTarifa(
  idTarifa: number,
  nuevoCosto: number,
  executor: Executor = getPool(),
): Promise<{ registros: number; valorAnterior: number; valorNuevo: number }> {
  const filas = await query<{ id_produccion: number; kwh: number; valor_q: number | null }>(
    'SELECT id_produccion, kwh, valor_q FROM produccion WHERE id_tarifa = ? AND activo = 1',
    [idTarifa],
    executor,
  );

  let valorAnterior = 0;
  let valorNuevo = 0;

  for (const fila of filas) {
    const nuevo = calcularValorQ(fila.kwh, nuevoCosto);
    valorAnterior += Number(fila.valor_q ?? 0);
    valorNuevo += nuevo;
    await execute(
      `UPDATE produccion
          SET costo_kwh_aplicado = ?, valor_q = ?, estado_valorizacion = 'VALORIZADA'
        WHERE id_produccion = ?`,
      [nuevoCosto, nuevo, fila.id_produccion],
      executor,
    );
  }

  return {
    registros: filas.length,
    valorAnterior: redondear(valorAnterior, 4),
    valorNuevo: redondear(valorNuevo, 4),
  };
}

// ---------------------------------------------------------------------------
// Cierre mensual
//
// El cierre sigue siendo MENSUAL porque la produccion y la proyeccion son
// mensuales; solo la tarifa cambia de periodicidad.
// ---------------------------------------------------------------------------

export async function mesEstaCerrado(
  idProyecto: number,
  anio: number,
  mes: number,
  executor: Executor = getPool(),
): Promise<boolean> {
  const fila = await queryOne<{ estado: string }>(
    'SELECT estado FROM cierres_mensuales WHERE id_proyecto = ? AND anio = ? AND mes = ?',
    [idProyecto, anio, mes],
    executor,
  );
  return fila?.estado === 'CERRADO';
}

/** Meses cerrados dentro de un trimestre: bloquean la correccion tarifaria. */
export async function mesesCerradosDelTrimestre(
  idProyecto: number,
  anio: number,
  trimestre: number,
  executor: Executor = getPool(),
): Promise<number[]> {
  const filas = await query<{ mes: number }>(
    `SELECT mes FROM cierres_mensuales
      WHERE id_proyecto = ? AND anio = ? AND estado = 'CERRADO'
        AND CEIL(mes / 3) = ?
      ORDER BY mes`,
    [idProyecto, anio, trimestre],
    executor,
  );
  return filas.map((f) => f.mes);
}

/** Lanza un error de negocio si el periodo esta cerrado. */
export async function exigirMesAbierto(
  idProyecto: number,
  anio: number,
  mes: number,
  executor: Executor = getPool(),
): Promise<void> {
  if (await mesEstaCerrado(idProyecto, anio, mes, executor)) {
    throw errores.reglaNegocio(
      `El periodo ${String(mes).padStart(2, '0')}/${anio} esta cerrado para este proyecto. ` +
        'Solicite su reapertura a un administrador, indicando el motivo.',
      { anio, mes },
    );
  }
}

/** Impide corregir la tarifa de un trimestre con meses ya cerrados. */
export async function exigirTrimestreAbierto(
  idProyecto: number,
  anio: number,
  trimestre: number,
  executor: Executor = getPool(),
): Promise<void> {
  const cerrados = await mesesCerradosDelTrimestre(idProyecto, anio, trimestre, executor);
  if (cerrados.length > 0) {
    throw errores.reglaNegocio(
      `El ${etiquetaTrimestre(anio, trimestre)} tiene ${cerrados.length} mes(es) cerrado(s) ` +
        `(${cerrados.map((m) => String(m).padStart(2, '0')).join(', ')}). ` +
        'Solicite su reapertura antes de modificar la tarifa.',
      { anio, trimestre, mesesCerrados: cerrados },
    );
  }
}

// ---------------------------------------------------------------------------
// Cobertura tarifaria
// ---------------------------------------------------------------------------

export interface CoberturaTarifaria {
  trimestresConTarifa: Array<{ anio: number; trimestre: number; etiqueta: string; costo_kwh: number }>;
  trimestresPendientes: Array<{ anio: number; trimestre: number; etiqueta: string }>;
  registrosPendientes: number;
  kwhPendientes: number;
  completa: boolean;
}

/**
 * Indicador de cobertura tarifaria de un periodo: cuantos trimestres tienen
 * tarifa aprobada y cuantos registros siguen sin valorizar. Un reporte oficial
 * con valor monetario no puede presentarse como completo si `completa` es falso.
 */
export async function coberturaTarifaria(
  filtros: { idProyecto?: number | null; idCliente?: number | null; desde: string; hasta: string },
  executor: Executor = getPool(),
): Promise<CoberturaTarifaria> {
  const condiciones: string[] = ['p.activo = 1', 'p.fecha BETWEEN ? AND ?'];
  const params: unknown[] = [filtros.desde, filtros.hasta];

  if (filtros.idProyecto) {
    condiciones.push('p.id_proyecto = ?');
    params.push(filtros.idProyecto);
  }
  if (filtros.idCliente) {
    condiciones.push('pr.id_cliente = ?');
    params.push(filtros.idCliente);
  }

  const donde = condiciones.join(' AND ');

  const periodos = await query<{
    id_proyecto: number;
    anio: number;
    trimestre: number;
    pendientes: number;
    kwh_pendientes: number;
  }>(
    `SELECT p.id_proyecto, p.anio, CEIL(p.mes / 3) AS trimestre,
            SUM(CASE WHEN p.estado_valorizacion = 'PENDIENTE_DE_TARIFA' THEN 1 ELSE 0 END) AS pendientes,
            COALESCE(SUM(CASE WHEN p.estado_valorizacion = 'PENDIENTE_DE_TARIFA' THEN p.kwh ELSE 0 END), 0) AS kwh_pendientes
       FROM produccion p
       JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
      WHERE ${donde}
      GROUP BY p.id_proyecto, p.anio, CEIL(p.mes / 3)
      ORDER BY p.anio, trimestre`,
    params,
    executor,
  );

  const conTarifa: CoberturaTarifaria['trimestresConTarifa'] = [];
  const pendientes: CoberturaTarifaria['trimestresPendientes'] = [];
  let registrosPendientes = 0;
  let kwhPendientes = 0;

  for (const periodo of periodos) {
    const tarifa = await buscarTarifaAprobada(
      periodo.id_proyecto,
      periodo.anio,
      periodo.trimestre,
      executor,
    );
    const etiqueta = etiquetaTrimestre(periodo.anio, periodo.trimestre);

    if (tarifa) {
      conTarifa.push({
        anio: periodo.anio,
        trimestre: periodo.trimestre,
        etiqueta,
        costo_kwh: tarifa.costo_kwh,
      });
    } else {
      pendientes.push({ anio: periodo.anio, trimestre: periodo.trimestre, etiqueta });
    }
    registrosPendientes += Number(periodo.pendientes ?? 0);
    kwhPendientes += Number(periodo.kwh_pendientes ?? 0);
  }

  return {
    trimestresConTarifa: conTarifa,
    trimestresPendientes: pendientes,
    registrosPendientes,
    kwhPendientes: redondear(kwhPendientes, 4),
    completa: pendientes.length === 0 && registrosPendientes === 0,
  };
}

// ---------------------------------------------------------------------------
// Alerta de actualizacion trimestral
// ---------------------------------------------------------------------------

export interface AlertaTrimestral {
  trimestreActual: { anio: number; trimestre: number; etiqueta: string };
  trimestreSiguiente: { anio: number; trimestre: number; etiqueta: string };
  diasRestantes: number;
  diasDeAviso: number;
  proyectosSinTarifaActual: Array<{ id_proyecto: number; proyecto: string }>;
  proyectosSinTarifaSiguiente: Array<{ id_proyecto: number; proyecto: string }>;
  requiereAtencion: boolean;
  mensaje: string | null;
}

/**
 * Alerta obligatoria de la tarifa trimestral.
 *
 * Avisa en dos momentos:
 *   a) El trimestre en curso no tiene tarifa aprobada (urgente: ya hay
 *      produccion que no se puede valorizar).
 *   b) Faltan pocos dias para que inicie el proximo trimestre y aun no tiene
 *      tarifa registrada (preventivo).
 */
export async function alertaTarifaTrimestral(
  diasDeAviso = 15,
  idProyecto?: number | null,
  executor: Executor = getPool(),
): Promise<AlertaTrimestral> {
  const actual = trimestreActual();
  const siguiente = trimestreSiguiente(actual.anio, actual.trimestre);
  const diasRestantes = diasRestantesDelTrimestre(actual.anio, actual.trimestre);

  const filtro = idProyecto ? 'AND pr.id_proyecto = ?' : '';
  const parametrosBase = idProyecto ? [idProyecto] : [];

  const sinTarifa = async (anio: number, trimestre: number) =>
    query<{ id_proyecto: number; proyecto: string }>(
      `SELECT pr.id_proyecto, pr.nombre AS proyecto
         FROM proyectos pr
        WHERE pr.activo = 1 ${filtro}
          AND NOT EXISTS (
            SELECT 1 FROM tarifas_kwh t
             WHERE t.id_proyecto = pr.id_proyecto
               AND t.anio = ? AND t.trimestre = ? AND t.estado = 'APROBADA'
          )
        ORDER BY pr.nombre`,
      [...parametrosBase, anio, trimestre],
      executor,
    );

  const proyectosSinTarifaActual = await sinTarifa(actual.anio, actual.trimestre);
  const proyectosSinTarifaSiguiente = await sinTarifa(siguiente.anio, siguiente.trimestre);

  const avisoAnticipado = diasRestantes <= diasDeAviso && proyectosSinTarifaSiguiente.length > 0;
  const requiereAtencion = proyectosSinTarifaActual.length > 0 || avisoAnticipado;

  let mensaje: string | null = null;
  if (proyectosSinTarifaActual.length > 0) {
    mensaje =
      `${proyectosSinTarifaActual.length} proyecto(s) no tienen tarifa aprobada para el ` +
      `${etiquetaTrimestre(actual.anio, actual.trimestre)}. Su produccion se esta registrando ` +
      'sin valor economico hasta que se registre y apruebe la tarifa.';
  } else if (avisoAnticipado) {
    mensaje =
      `El ${etiquetaTrimestre(actual.anio, actual.trimestre)} termina en ${diasRestantes} dia(s) y ` +
      `${proyectosSinTarifaSiguiente.length} proyecto(s) aun no tienen tarifa para el ` +
      `${etiquetaTrimestre(siguiente.anio, siguiente.trimestre)}. Registrela antes del cambio de trimestre.`;
  }

  return {
    trimestreActual: { ...actual, etiqueta: etiquetaTrimestre(actual.anio, actual.trimestre) },
    trimestreSiguiente: { ...siguiente, etiqueta: etiquetaTrimestre(siguiente.anio, siguiente.trimestre) },
    diasRestantes,
    diasDeAviso,
    proyectosSinTarifaActual,
    proyectosSinTarifaSiguiente,
    requiereAtencion,
    mensaje,
  };
}

/** Trimestres cubiertos por un rango, util para los filtros de reportes. */
export function trimestresDeRango(desde: string, hasta: string) {
  return trimestresDelPeriodo({ desde, hasta }).map((t) => ({
    ...t,
    etiqueta: etiquetaTrimestre(t.anio, t.trimestre),
  }));
}
