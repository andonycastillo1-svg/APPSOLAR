/**
 * Utilidades numericas del dominio energetico y monetario.
 *
 * Politica de redondeo documentada (criterio de aceptacion 11.5):
 *  - La energia (kWh) se almacena con 4 decimales.
 *  - La tarifa (Q/kWh) se almacena con 6 decimales.
 *  - El valor monetario se calcula como kwh * costo_kwh y se redondea a
 *    4 decimales al almacenar (half-up) y se PRESENTA con 2 decimales.
 *  - Las sumas de un rango se hacen sobre los valores ya redondeados de cada
 *    registro; nunca se multiplica el total del rango por una sola tarifa.
 */

export const DECIMALES_KWH = 4;
export const DECIMALES_TARIFA = 6;
export const DECIMALES_VALOR = 4;

/** Redondeo "half-up" estable, inmune a los artefactos binarios habituales. */
export function redondear(valor: number, decimales: number): number {
  if (!Number.isFinite(valor)) return 0;
  const factor = Math.pow(10, decimales);
  const escalado = valor * factor;
  // Corrige casos como 1.005 * 100 = 100.49999999999999
  const corregido = Number(escalado.toPrecision(15));
  return Math.round(corregido) / factor;
}

export function redondearKwh(valor: number): number {
  return redondear(valor, DECIMALES_KWH);
}

export function redondearValor(valor: number): number {
  return redondear(valor, DECIMALES_VALOR);
}

/** valor_q = kwh x costo_kwh_aplicado (redondeado a 4 decimales) */
export function calcularValorQ(kwh: number, costoKwh: number): number {
  return redondearValor(kwh * costoKwh);
}

/**
 * Convierte texto proveniente de archivos a numero.
 * Acepta separador decimal `.` o `,` y separadores de miles, tal como
 * aparecen en los archivos historicos de Excel.
 */
export function parsearNumero(entrada: unknown): number | null {
  if (entrada === null || entrada === undefined || entrada === '') return null;
  if (typeof entrada === 'number') return Number.isFinite(entrada) ? entrada : null;

  let texto = String(entrada).trim();
  if (!texto) return null;
  texto = texto.replace(/\s/g, '').replace(/kwh$/i, '').replace(/^Q/i, '');

  const tieneComa = texto.includes(',');
  const tienePunto = texto.includes('.');

  if (tieneComa && tienePunto) {
    // El ultimo separador que aparece es el decimal.
    if (texto.lastIndexOf(',') > texto.lastIndexOf('.')) {
      texto = texto.replace(/\./g, '').replace(',', '.');
    } else {
      texto = texto.replace(/,/g, '');
    }
  } else if (tieneComa) {
    const partes = texto.split(',');
    // "1,234" con 3 digitos finales se interpreta como separador de miles.
    texto =
      partes.length === 2 && partes[1].length === 3 && partes[0].length <= 3
        ? partes.join('')
        : texto.replace(',', '.');
  }

  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : null;
}

/** Variacion porcentual protegida contra division entre cero. */
export function variacionPorcentual(actual: number, anterior: number): number | null {
  if (!anterior) return null;
  return redondear(((actual - anterior) / anterior) * 100, 2);
}

/** Cumplimiento = real / proyeccion x 100. `null` cuando no hay proyeccion. */
export function porcentajeCumplimiento(real: number, proyeccion: number | null): number | null {
  if (proyeccion === null || proyeccion === undefined || proyeccion <= 0) return null;
  return redondear((real / proyeccion) * 100, 2);
}
