/**
 * Manejo de fechas y periodos.
 * Regla del sistema: en API y base de datos se usa ISO (`YYYY-MM-DD`);
 * la interfaz presenta `dd/mm/aaaa`. La zona horaria oficial es
 * America/Guatemala (UTC-6, sin horario de verano), por lo que se trabaja
 * con fechas civiles sin componente de hora para evitar desplazamientos.
 */

export const ZONA_HORARIA = 'America/Guatemala';

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

/** Normaliza un mes escrito en espanol o como numero a 1..12. */
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
// Trimestres
//
// La tarifa del kWh tiene vigencia TRIMESTRAL sobre trimestres calendario.
// La produccion y la proyeccion siguen siendo mensuales: solo la tarifa
// cambia de periodicidad.
// ---------------------------------------------------------------------------

export const TRIMESTRES = [
  { numero: 1, etiqueta: 'I trimestre', meses: 'Enero a Marzo' },
  { numero: 2, etiqueta: 'II trimestre', meses: 'Abril a Junio' },
  { numero: 3, etiqueta: 'III trimestre', meses: 'Julio a Septiembre' },
  { numero: 4, etiqueta: 'IV trimestre', meses: 'Octubre a Diciembre' },
];

/** Trimestre calendario (1..4) al que pertenece un mes. */
export function trimestreDeMes(mes: number): number {
  return Math.ceil(mes / 3);
}

/** Los tres meses que componen un trimestre. */
export function mesesDelTrimestre(trimestre: number): number[] {
  const primero = (trimestre - 1) * 3 + 1;
  return [primero, primero + 1, primero + 2];
}

export function etiquetaTrimestre(anio: number, trimestre: number): string {
  const definicion = TRIMESTRES[trimestre - 1];
  return definicion ? `${definicion.etiqueta} ${anio}` : `T${trimestre} ${anio}`;
}

export function nombreMesesTrimestre(trimestre: number): string {
  return TRIMESTRES[trimestre - 1]?.meses ?? '';
}

export function primerDiaTrimestre(anio: number, trimestre: number): string {
  return primerDiaMes(anio, (trimestre - 1) * 3 + 1);
}

export function ultimoDiaTrimestre(anio: number, trimestre: number): string {
  return ultimoDiaMes(anio, trimestre * 3);
}

/** Trimestre en curso segun la fecha civil de Guatemala. */
export function trimestreActual(): { anio: number; trimestre: number } {
  const hoy = hoyISO();
  return { anio: Number(hoy.slice(0, 4)), trimestre: trimestreDeMes(Number(hoy.slice(5, 7))) };
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
    const trimestre = trimestreDeMes(mes.mes);
    const clave = `${mes.anio}-${trimestre}`;
    if (!vistos.has(clave)) {
      vistos.add(clave);
      salida.push({ anio: mes.anio, trimestre });
    }
  }
  return salida;
}
