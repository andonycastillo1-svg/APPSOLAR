/**
 * Formato de presentacion en español de Guatemala.
 * Energia en kWh, potencia instalada en kWp, moneda GTQ (Q),
 * fechas visibles en dd/mm/aaaa y zona horaria America/Guatemala.
 */

export const ZONA_HORARIA = 'America/Guatemala';

const numeroEs = (decimales: number) =>
  new Intl.NumberFormat('es-GT', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });

export function numero(valor: number | string | null | undefined, decimales = 2): string {
  if (valor === null || valor === undefined || valor === '') return '—';
  const n = Number(valor);
  if (!Number.isFinite(n)) return '—';
  return numeroEs(decimales).format(n);
}

/** Energia generada. SIEMPRE kWh: jamas se etiqueta la generacion como kWp. */
export function kwh(valor: number | string | null | undefined, decimales = 2): string {
  if (valor === null || valor === undefined) return '—';
  return `${numero(valor, decimales)} kWh`;
}

/** Potencia instalada. Unico uso valido de kWp. */
export function kwp(valor: number | string | null | undefined): string {
  if (valor === null || valor === undefined) return 'No registrada';
  return `${numero(valor, 3)} kWp`;
}

export function quetzales(valor: number | string | null | undefined, decimales = 2): string {
  if (valor === null || valor === undefined) return 'Pendiente de tarifa';
  return `Q ${numero(valor, decimales)}`;
}

export function tarifa(valor: number | string | null | undefined): string {
  if (valor === null || valor === undefined) return 'Sin tarifa';
  return `Q ${numero(valor, 6)} / kWh`;
}

export function porcentaje(valor: number | string | null | undefined, decimales = 2): string {
  if (valor === null || valor === undefined) return 'Sin base de comparacion';
  return `${numero(valor, decimales)} %`;
}

/** Convierte una fecha ISO del API al formato visible dd/mm/aaaa. */
export function fecha(iso: string | null | undefined): string {
  if (!iso) return '—';
  const soloFecha = String(iso).slice(0, 10);
  const [a, m, d] = soloFecha.split('-');
  if (!a || !m || !d) return String(iso);
  return `${d}/${m}/${a}`;
}

export function fechaHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const texto = String(iso);
  const valor = new Date(texto.includes('T') ? texto : texto.replace(' ', 'T') + 'Z');
  if (Number.isNaN(valor.getTime())) return texto;
  return new Intl.DateTimeFormat('es-GT', {
    timeZone: ZONA_HORARIA,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(valor);
}

export const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export function nombreMes(mes: number): string {
  return MESES[mes - 1] ?? String(mes);
}

/** Fecha civil de hoy en la zona horaria oficial, en ISO. */
export function hoyISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function inicioDeAnioISO(): string {
  return `${hoyISO().slice(0, 4)}-01-01`;
}

export function inicioDeMesISO(): string {
  return `${hoyISO().slice(0, 7)}-01`;
}

export function anioActual(): number {
  return Number(hoyISO().slice(0, 4));
}

/**
 * Anio tarifario en curso: los trimestres de la tarifa inician en noviembre,
 * asi que el anio tarifario 2025 va de noviembre 2025 a octubre 2026.
 */
export function anioTarifarioActual(): number {
  const hoy = new Date();
  return hoy.getMonth() + 1 >= 11 ? hoy.getFullYear() : hoy.getFullYear() - 1;
}

/** Clase de etiqueta segun el estado del dato. */
export function claseEstado(estado: string | null | undefined): string {
  switch (String(estado ?? '').toUpperCase()) {
    case 'APROBADA':
    case 'COMPLETADO':
    case 'COMPLETADA':
    case 'ACTIVO':
    case 'ACTIVA':
    case 'VALORIZADA':
    case 'EXITO':
      return 'etiqueta etiqueta--verde';
    case 'BORRADOR':
    case 'PENDIENTE':
    case 'VALIDANDO':
    case 'PROCESANDO':
    case 'EN_PROCESO':
    case 'PENDIENTE_DE_TARIFA':
    case 'COMPLETADO_CON_ERRORES':
    case 'COMPLETADA_CON_ERRORES':
    case 'MANTENIMIENTO':
    case 'PENDIENTE_AUTORIZACION':
    case 'PARCIAL':
      return 'etiqueta etiqueta--ambar';
    case 'FALLIDO':
    case 'FALLIDA':
    case 'ANULADA':
    case 'RECHAZADO':
    case 'FALLO':
      return 'etiqueta etiqueta--rojo';
    case 'VALIDADO':
    case 'MOCK':
      return 'etiqueta etiqueta--azul';
    default:
      return 'etiqueta etiqueta--gris';
  }
}

export function textoEstado(estado: string | null | undefined): string {
  const mapa: Record<string, string> = {
    PENDIENTE_DE_TARIFA: 'Pendiente de tarifa',
    COMPLETADO_CON_ERRORES: 'Completado con errores',
    COMPLETADA_CON_ERRORES: 'Completada con errores',
    EN_PROCESO: 'En proceso',
    PENDIENTE_AUTORIZACION: 'Pendiente de autorizacion',
    PROYECTO_CONSOLIDADO: 'Consolidado del proyecto',
    POR_INVERSOR: 'Detalle por inversor',
    HUAWEI_API: 'Huawei SmartPVMS',
    PACTADA: 'Valor pactado',
    MOCK: 'Simulado',
    REAL: 'Real',
  };
  const clave = String(estado ?? '').toUpperCase();
  if (mapa[clave]) return mapa[clave];
  if (!clave) return '—';
  return clave.charAt(0) + clave.slice(1).toLowerCase().replace(/_/g, ' ');
}
