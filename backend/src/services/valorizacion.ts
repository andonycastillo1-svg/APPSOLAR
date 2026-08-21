import { execute, query, queryOne, type Executor, getPool } from '../db/pool';
import { calcularValorQ, redondear } from '../utils/numeros';
import { errores } from '../utils/errors';

/**
 * Motor de valorizacion monetaria.
 *
 * Reglas fundamentales (seccion 6.5.1 y 10 del alcance):
 *  - Cada registro de produccion se valoriza con la tarifa APROBADA del
 *    proyecto correspondiente al ANIO y MES de su propia fecha.
 *  - Si el mes no tiene tarifa aprobada, los kWh se conservan intactos y el
 *    registro queda en `PENDIENTE_DE_TARIFA`. Nunca se usa cero ni la tarifa
 *    del mes anterior de forma automatica.
 *  - Se guarda `id_tarifa` y una copia de `costo_kwh_aplicado` para trazabilidad.
 *  - En rangos multi-mes se valoriza registro por registro y luego se suma.
 */

export interface TarifaAprobada {
  id_tarifa: number;
  id_proyecto: number;
  anio: number;
  mes: number;
  costo_kwh: number;
  moneda: string;
}

export async function buscarTarifaAprobada(
  idProyecto: number,
  anio: number,
  mes: number,
  executor: Executor = getPool(),
): Promise<TarifaAprobada | null> {
  return queryOne<TarifaAprobada>(
    `SELECT id_tarifa, id_proyecto, anio, mes, costo_kwh, moneda
       FROM tarifas_kwh
      WHERE id_proyecto = ? AND anio = ? AND mes = ? AND estado = 'APROBADA'
      LIMIT 1`,
    [idProyecto, anio, mes],
    executor,
  );
}

/** Cache por lote para no repetir consultas al valorizar muchos registros. */
export class CacheTarifas {
  private readonly mapa = new Map<string, TarifaAprobada | null>();

  constructor(private readonly executor: Executor = getPool()) {}

  async obtener(idProyecto: number, anio: number, mes: number): Promise<TarifaAprobada | null> {
    const clave = `${idProyecto}|${anio}|${mes}`;
    if (!this.mapa.has(clave)) {
      this.mapa.set(clave, await buscarTarifaAprobada(idProyecto, anio, mes, this.executor));
    }
    return this.mapa.get(clave) ?? null;
  }

  /** Meses consultados que resultaron sin tarifa aprobada. */
  mesesPendientes(): Array<{ anio: number; mes: number }> {
    const salida: Array<{ anio: number; mes: number }> = [];
    for (const [clave, valor] of this.mapa.entries()) {
      if (!valor) {
        const [, anio, mes] = clave.split('|').map(Number);
        salida.push({ anio, mes });
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
    : await buscarTarifaAprobada(idProyecto, anio, mes, executor);

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
 * Valoriza los registros que quedaron pendientes de un proyecto/mes.
 * Se invoca al registrar o aprobar una tarifa faltante. NO toca registros
 * que ya estaban valorizados.
 */
export async function recalcularPendientes(
  idProyecto: number,
  anio: number,
  mes: number,
  executor: Executor = getPool(),
): Promise<{ registros: number; kwh: number; valor: number }> {
  const tarifa = await buscarTarifaAprobada(idProyecto, anio, mes, executor);
  if (!tarifa) return { registros: 0, kwh: 0, valor: 0 };

  const pendientes = await query<{ id_produccion: number; kwh: number }>(
    `SELECT id_produccion, kwh
       FROM produccion
      WHERE id_proyecto = ? AND anio = ? AND mes = ?
        AND activo = 1 AND estado_valorizacion = 'PENDIENTE_DE_TARIFA'`,
    [idProyecto, anio, mes],
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
  mes: number;
  costoActual: number;
  costoPropuesto: number;
  registrosAfectados: number;
  kwhAfectados: number;
  valorAnterior: number;
  valorNuevo: number;
  diferencia: number;
  mesCerrado: boolean;
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
    mes: number;
    costo_kwh: number;
  }>(
    'SELECT id_tarifa, id_proyecto, anio, mes, costo_kwh FROM tarifas_kwh WHERE id_tarifa = ?',
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
    mes: tarifa.mes,
    costoActual: tarifa.costo_kwh,
    costoPropuesto,
    registrosAfectados: Number(resumen?.registros ?? 0),
    kwhAfectados: redondear(kwh, 4),
    valorAnterior,
    valorNuevo,
    diferencia: redondear(valorNuevo - valorAnterior, 4),
    mesCerrado: await mesEstaCerrado(tarifa.id_proyecto, tarifa.anio, tarifa.mes, executor),
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

// ---------------------------------------------------------------------------
// Cobertura tarifaria
// ---------------------------------------------------------------------------

export interface CoberturaTarifaria {
  mesesConTarifa: Array<{ anio: number; mes: number; costo_kwh: number }>;
  mesesPendientes: Array<{ anio: number; mes: number }>;
  registrosPendientes: number;
  kwhPendientes: number;
  completa: boolean;
}

/**
 * Indicador de cobertura tarifaria de un periodo: cuantos meses tienen tarifa
 * aprobada y cuantos registros siguen sin valorizar. Un reporte oficial con
 * valor monetario no puede presentarse como completo si `completa` es falso.
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
    mes: number;
    pendientes: number;
    kwh_pendientes: number;
  }>(
    `SELECT p.id_proyecto, p.anio, p.mes,
            SUM(CASE WHEN p.estado_valorizacion = 'PENDIENTE_DE_TARIFA' THEN 1 ELSE 0 END) AS pendientes,
            COALESCE(SUM(CASE WHEN p.estado_valorizacion = 'PENDIENTE_DE_TARIFA' THEN p.kwh ELSE 0 END), 0) AS kwh_pendientes
       FROM produccion p
       JOIN proyectos pr ON pr.id_proyecto = p.id_proyecto
      WHERE ${donde}
      GROUP BY p.id_proyecto, p.anio, p.mes
      ORDER BY p.anio, p.mes`,
    params,
    executor,
  );

  const conTarifa: CoberturaTarifaria['mesesConTarifa'] = [];
  const pendientes: CoberturaTarifaria['mesesPendientes'] = [];
  let registrosPendientes = 0;
  let kwhPendientes = 0;

  for (const periodo of periodos) {
    const tarifa = await buscarTarifaAprobada(
      periodo.id_proyecto,
      periodo.anio,
      periodo.mes,
      executor,
    );
    if (tarifa) {
      conTarifa.push({ anio: periodo.anio, mes: periodo.mes, costo_kwh: tarifa.costo_kwh });
    } else {
      pendientes.push({ anio: periodo.anio, mes: periodo.mes });
    }
    registrosPendientes += Number(periodo.pendientes ?? 0);
    kwhPendientes += Number(periodo.kwh_pendientes ?? 0);
  }

  return {
    mesesConTarifa: conTarifa,
    mesesPendientes: pendientes,
    registrosPendientes,
    kwhPendientes: redondear(kwhPendientes, 4),
    completa: pendientes.length === 0 && registrosPendientes === 0,
  };
}
