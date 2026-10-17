/**
 * Manejo de fechas y periodos.
 * Regla del sistema: en API y base de datos se usa ISO (`YYYY-MM-DD`);
 * la interfaz presenta `dd/mm/aaaa`. La zona horaria oficial es
 * America/Guatemala (UTC-6, sin horario de verano), por lo que se trabaja
 * con fechas civiles sin componente de hora para evitar desplazamientos.
 */

export const ZONA_HORARIA = 'America/Guatemala';

/**
 * Fecha y hora actual en Guatemala con el formato de MySQL (`YYYY-MM-DD HH:mm:ss`).
 * Reemplaza a `new Date().toISOString()`, que da la hora UTC y desfasaria la auditoria.
 */
export function ahoraGuatemala(): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '00';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')}`;
}

export const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const ALIAS_MESES: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, septiembre: 9, setiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, diciembre: 12, dec: 12, december: 12,
};

function quitarAcentos(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Normaliza un mes escrito en español o como numero a 1..12. */
export function normalizarMes(entrada: unknown): number | null {
  if (entrada === null || entrada === undefined || entrada === '') return null;

  if (typeof entrada === 'number' && Number.isInteger(entrada)) {
    return entrada >= 1 && entrada <= 12 ? entrada : null;
  }

  const texto = quitarAcentos(String(entrada).trim().toLowerCase()).replace(/\.$/, '');
  if (!texto) return null;

  if (/^\d{1,2}$/.test(texto)) {
    const numero = Number(texto);
    return numero >= 1 && numero <= 12 ? numero : null;
  }

  return ALIAS_MESES[texto] ?? null;
}

export function nombreMes(mes: number): string {
  return MESES_ES[mes - 1] ?? String(mes);
}

/** Fecha civil de hoy en la zona horaria oficial, en formato ISO. */
export function hoyISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function anioActual(): number {
  return Number(hoyISO().slice(0, 4));
}

export function esFechaISO(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [a, m, d] = valor.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const dias = diasEnMes(a, m);
  return d >= 1 && d <= dias;
}

export function diasEnMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

export function primerDiaMes(anio: number, mes: number): string {
  return `${anio}-${String(mes).padStart(2, '0')}-01`;
}

export function ultimoDiaMes(anio: number, mes: number): string {
  return `${anio}-${String(mes).padStart(2, '0')}-${String(diasEnMes(anio, mes)).padStart(2, '0')}`;
}

/**
 * Normaliza fechas provenientes de archivos: ISO, dd/mm/aaaa, dd-mm-aaaa,
 * aaaa/mm/dd y el numero serial de Excel.
 */
export function normalizarFecha(entrada: unknown): string | null {
  if (entrada === null || entrada === undefined || entrada === '') return null;

  if (entrada instanceof Date && !Number.isNaN(entrada.getTime())) {
    const a = entrada.getUTCFullYear();
    const m = String(entrada.getUTCMonth() + 1).padStart(2, '0');
    const d = String(entrada.getUTCDate()).padStart(2, '0');
    return `${a}-${m}-${d}`;
  }

  if (typeof entrada === 'number' && Number.isFinite(entrada)) {
    // Serial de Excel (1900-based). 25569 = dias entre 1899-12-30 y 1970-01-01.
    const ms = Math.round((entrada - 25569) * 86400 * 1000);
    const fecha = new Date(ms);
    if (Number.isNaN(fecha.getTime())) return null;
    return normalizarFecha(fecha);
  }

  const texto = String(entrada).trim();
  if (!texto) return null;

  const iso = texto.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const valor = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    return esFechaISO(valor) ? valor : null;
  }

  const dmy = texto.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmy) {
    const valor = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    return esFechaISO(valor) ? valor : null;
  }

  return null;
}

export interface Periodo {
  desde: string;
  hasta: string;
}

/** Periodo inmediatamente anterior de la misma duracion (comparacion justa). */
export function periodoAnterior(periodo: Periodo): Periodo {
  const desde = new Date(`${periodo.desde}T00:00:00Z`);
  const hasta = new Date(`${periodo.hasta}T00:00:00Z`);
  const dias = Math.round((hasta.getTime() - desde.getTime()) / 86400000) + 1;
  const nuevoHasta = new Date(desde.getTime() - 86400000);
  const nuevoDesde = new Date(nuevoHasta.getTime() - (dias - 1) * 86400000);
  const iso = (f: Date) => f.toISOString().slice(0, 10);
  return { desde: iso(nuevoDesde), hasta: iso(nuevoHasta) };
}

/** Lista de pares (anio, mes) cubiertos por un rango de fechas. */
export function mesesDelPeriodo(periodo: Periodo): Array<{ anio: number; mes: number }> {
  const resultado: Array<{ anio: number; mes: number }> = [];
  let [anio, mes] = [Number(periodo.desde.slice(0, 4)), Number(periodo.desde.slice(5, 7))];
  const anioFin = Number(periodo.hasta.slice(0, 4));
  const mesFin = Number(periodo.hasta.slice(5, 7));

  while (anio < anioFin || (anio === anioFin && mes <= mesFin)) {
    resultado.push({ anio, mes });
    mes += 1;
    if (mes > 12) {
      mes = 1;
      anio += 1;
    }
    if (resultado.length > 600) break; // guarda de seguridad
  }
  return resultado;
}

export function formatoLargoEs(fechaISO: string): string {
  const [a, m, d] = fechaISO.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

export function ahoraLocal(): string {
  return new Intl.DateTimeFormat('es-GT', {
    timeZone: ZONA_HORARIA,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());
}

// ---------------------------------------------------------------------------
// Trimestres tarifarios
//
// La tarifa del kWh tiene vigencia TRIMESTRAL, pero los trimestres NO son los
// calendario: el primer periodo inicia en noviembre.
//
//   I   trimestre: Noviembre - Diciembre - Enero
//   II  trimestre: Febrero   - Marzo     - Abril
//   III trimestre: Mayo      - Junio     - Julio
//   IV  trimestre: Agosto    - Septiembre- Octubre
//
// Un "anio tarifario" va de noviembre a octubre y se identifica con el anio
// calendario en que INICIA (el anio tarifario 2025 es nov-2025 a oct-2026).
// La produccion y la proyeccion siguen siendo mensuales: solo la tarifa usa
// estos periodos.
// ---------------------------------------------------------------------------

export const TRIMESTRES = [
  { numero: 1, etiqueta: 'I trimestre', meses: 'Noviembre a Enero' },
  { numero: 2, etiqueta: 'II trimestre', meses: 'Febrero a Abril' },
  { numero: 3, etiqueta: 'III trimestre', meses: 'Mayo a Julio' },
  { numero: 4, etiqueta: 'IV trimestre', meses: 'Agosto a Octubre' },
];

const ABREVIATURAS_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Expresiones SQL equivalentes a las funciones de abajo, para agrupar o
 * filtrar registros con columnas (anio, mes) por periodo tarifario.
 */
export function sqlAnioTarifario(columnaAnio = 'anio', columnaMes = 'mes'): string {
  return `IF(${columnaMes} >= 11, ${columnaAnio}, ${columnaAnio} - 1)`;
}

export function sqlTrimestre(columnaMes = 'mes'): string {
  return `(FLOOR((${columnaMes} + 1) % 12 / 3) + 1)`;
}

/** Trimestre tarifario (1..4) al que pertenece un mes calendario. */
export function trimestreDeMes(mes: number): number {
  return Math.floor(((mes + 1) % 12) / 3) + 1;
}

/** Anio tarifario (el anio en que inicia el noviembre) de un mes calendario. */
export function anioTarifario(anio: number, mes: number): number {
  return mes >= 11 ? anio : anio - 1;
}

/** Periodo tarifario (anio tarifario + trimestre) de un mes calendario. */
export function periodoTarifario(anio: number, mes: number): { anio: number; trimestre: number } {
  return { anio: anioTarifario(anio, mes), trimestre: trimestreDeMes(mes) };
}

/** Los tres meses calendario que componen un trimestre (1 = 11, 12, 1). */
export function mesesDelTrimestre(trimestre: number): number[] {
  const primero = trimestre === 1 ? 11 : (trimestre - 2) * 3 + 2;
  return [0, 1, 2].map((i) => ((primero - 1 + i) % 12) + 1);
}

/** Los tres (anio, mes) concretos de un trimestre de un anio tarifario. */
export function mesesDelPeriodoTarifario(
  anioTarif: number,
  trimestre: number,
): Array<{ anio: number; mes: number }> {
  return mesesDelTrimestre(trimestre).map((mes) => ({
    // Nov y Dic pertenecen al anio de inicio; el resto, al siguiente.
    anio: mes >= 11 ? anioTarif : anioTarif + 1,
    mes,
  }));
}

function rangoTrimestre(anio: number, trimestre: number): string {
  const meses = mesesDelPeriodoTarifario(anio, trimestre);
  const primero = meses[0];
  const ultimo = meses[2];
  return `${ABREVIATURAS_MES[primero.mes - 1]} ${primero.anio} a ${ABREVIATURAS_MES[ultimo.mes - 1]} ${ultimo.anio}`;
}

export function etiquetaTrimestre(anio: number, trimestre: number): string {
  const definicion = TRIMESTRES[trimestre - 1];
  if (!definicion) return `T${trimestre} ${anio}`;
  return `${definicion.etiqueta} ${anio} (${rangoTrimestre(anio, trimestre)})`;
}

export function nombreMesesTrimestre(trimestre: number): string {
  return TRIMESTRES[trimestre - 1]?.meses ?? '';
}

export function primerDiaTrimestre(anio: number, trimestre: number): string {
  const primero = mesesDelPeriodoTarifario(anio, trimestre)[0];
  return primerDiaMes(primero.anio, primero.mes);
}

export function ultimoDiaTrimestre(anio: number, trimestre: number): string {
  const ultimo = mesesDelPeriodoTarifario(anio, trimestre)[2];
  return ultimoDiaMes(ultimo.anio, ultimo.mes);
}

/** Trimestre en curso segun la fecha civil de Guatemala. */
export function trimestreActual(): { anio: number; trimestre: number } {
  const hoy = hoyISO();
  return periodoTarifario(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)));
}

export function trimestreSiguiente(anio: number, trimestre: number): { anio: number; trimestre: number } {
  return trimestre === 4 ? { anio: anio + 1, trimestre: 1 } : { anio, trimestre: trimestre + 1 };
}

/** Dias que faltan para que termine el trimestre indicado (0 si ya termino). */
export function diasRestantesDelTrimestre(anio: number, trimestre: number): number {
  const fin = new Date(`${ultimoDiaTrimestre(anio, trimestre)}T00:00:00Z`);
  const hoy = new Date(`${hoyISO()}T00:00:00Z`);
  return Math.max(0, Math.round((fin.getTime() - hoy.getTime()) / 86400000));
}

/** Trimestres distintos cubiertos por un rango de fechas. */
export function trimestresDelPeriodo(periodo: Periodo): Array<{ anio: number; trimestre: number }> {
  const vistos = new Set<string>();
  const salida: Array<{ anio: number; trimestre: number }> = [];

  for (const mes of mesesDelPeriodo(periodo)) {
    const p = periodoTarifario(mes.anio, mes.mes);
    const clave = `${p.anio}-${p.trimestre}`;
    if (!vistos.has(clave)) {
      vistos.add(clave);
      salida.push(p);
    }
  }
  return salida;
}
