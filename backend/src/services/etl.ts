import ExcelJS from 'exceljs';
import { detectarFormula, neutralizarFormula } from './archivos';
import { normalizarFecha, normalizarMes, esFechaISO, hoyISO, MESES_ES } from '../utils/fechas';
import { parsearNumero, redondearKwh } from '../utils/numeros';
import { errores } from '../utils/errors';

/**
 * ETL de importacion manual.
 *
 * Soporta dos formatos de plantilla:
 *  1. NORMALIZADO      -> fecha, kwh, inversor_serial, comentarios
 *  2. HISTORICO_EXCEL  -> Planta, Tipo, Año, Mes, Generacion, Comentarios
 *                          (+ Inversor/Serial opcional)
 *
 * El resultado es un conjunto de filas canonicas mas la lista de errores y
 * advertencias por fila, que alimenta la previsualizacion del asistente.
 */

export type FormatoArchivo = 'NORMALIZADO' | 'HISTORICO_EXCEL';

export interface ProblemaFila {
  fila: number;
  columna: string | null;
  valor: string | null;
  codigo: string;
  severidad: 'ERROR' | 'ADVERTENCIA';
  mensaje: string;
}

export interface FilaCanonica {
  fila: number;
  planta: string | null;
  tipo: string | null;
  anio: number;
  mes: number;
  fecha: string;
  granularidad: 'DIARIA' | 'MENSUAL';
  kwh: number;
  serial: string | null;
  comentarios: string | null;
}

export interface ResultadoLectura {
  formato: FormatoArchivo;
  encabezados: string[];
  mapeoDetectado: Record<string, string>;
  filas: FilaCanonica[];
  problemas: ProblemaFila[];
  totalFilasLeidas: number;
}

// ---------------------------------------------------------------------------
// Normalizacion de encabezados
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92);

function normalizarEncabezado(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(new RegExp('[' + BS + 'u0300-' + BS + 'u036f]', 'g'), '')
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, '_');
}

const ALIAS_NORMALIZADO: Record<string, string> = {
  fecha: 'fecha',
  dia: 'fecha',
  date: 'fecha',
  kwh: 'kwh',
  energia: 'kwh',
  energia_kwh: 'kwh',
  generacion: 'kwh',
  generacion_kwh: 'kwh',
  produccion: 'kwh',
  inversor_serial: 'serial',
  serial: 'serial',
  inversor: 'serial',
  numero_serie: 'serial',
  comentarios: 'comentarios',
  comentario: 'comentarios',
  observaciones: 'comentarios',
  notas: 'comentarios',
};

const ALIAS_HISTORICO: Record<string, string> = {
  planta: 'planta',
  proyecto: 'planta',
  nombre_planta: 'planta',
  tipo: 'tipo',
  modalidad: 'tipo',
  ano: 'anio',
  anio: 'anio',
  year: 'anio',
  mes: 'mes',
  month: 'mes',
  generacion: 'generacion',
  generacion_kwh: 'generacion',
  kwh: 'generacion',
  produccion: 'generacion',
  comentarios: 'comentarios',
  comentario: 'comentarios',
  observaciones: 'comentarios',
  inversor: 'serial',
  serial: 'serial',
  inversor_serial: 'serial',
};

/** Determina el formato del archivo a partir de sus encabezados. */
export function detectarFormato(encabezados: string[]): {
  formato: FormatoArchivo;
  mapeo: Record<string, string>;
} {
  const normalizados = encabezados.map(normalizarEncabezado);

  const mapeoHistorico: Record<string, string> = {};
  const mapeoNormalizado: Record<string, string> = {};

  normalizados.forEach((h, indice) => {
    if (ALIAS_HISTORICO[h] && !mapeoHistorico[ALIAS_HISTORICO[h]]) {
      mapeoHistorico[ALIAS_HISTORICO[h]] = encabezados[indice];
    }
    if (ALIAS_NORMALIZADO[h] && !mapeoNormalizado[ALIAS_NORMALIZADO[h]]) {
      mapeoNormalizado[ALIAS_NORMALIZADO[h]] = encabezados[indice];
    }
  });

  const esHistorico =
    Boolean(mapeoHistorico.planta) &&
    Boolean(mapeoHistorico.anio) &&
    Boolean(mapeoHistorico.mes) &&
    Boolean(mapeoHistorico.generacion);

  const esNormalizado = Boolean(mapeoNormalizado.fecha) && Boolean(mapeoNormalizado.kwh);

  if (esHistorico) return { formato: 'HISTORICO_EXCEL', mapeo: mapeoHistorico };
  if (esNormalizado) return { formato: 'NORMALIZADO', mapeo: mapeoNormalizado };

  throw errores.validacion(
    'No se reconocieron los encabezados del archivo. Use la plantilla normalizada ' +
      '(fecha, kwh, inversor_serial, comentarios) o el formato historico ' +
      '(Planta, Tipo, Año, Mes, Generacion, Comentarios).',
    { encabezadosRecibidos: encabezados },
  );
}

// ---------------------------------------------------------------------------
// Lectura de archivos
// ---------------------------------------------------------------------------

interface FilaCruda {
  numero: number;
  valores: Record<string, unknown>;
}

/** Divisor de CSV que respeta comillas dobles y campos con separador dentro. */
function partirLineaCsv(linea: string, separador: string): string[] {
  const campos: string[] = [];
  let actual = '';
  let enComillas = false;

  for (let i = 0; i < linea.length; i += 1) {
    const caracter = linea[i];
    if (caracter === '"') {
      if (enComillas && linea[i + 1] === '"') {
        actual += '"';
        i += 1;
      } else {
        enComillas = !enComillas;
      }
    } else if (caracter === separador && !enComillas) {
      campos.push(actual);
      actual = '';
    } else {
      actual += caracter;
    }
  }
  campos.push(actual);
  return campos.map((c) => c.trim());
}

function detectarSeparador(primeraLinea: string): string {
  const candidatos = [';', ',', '\t', '|'];
  let mejor = ',';
  let maximo = 0;
  for (const candidato of candidatos) {
    const cuenta = partirLineaCsv(primeraLinea, candidato).length;
    if (cuenta > maximo) {
      maximo = cuenta;
      mejor = candidato;
    }
  }
  return mejor;
}

function leerCsv(contenido: Buffer): { encabezados: string[]; filas: FilaCruda[] } {
  let texto = contenido.toString('utf8');
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1); // BOM

  const lineas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lineas.length === 0) throw errores.validacion('El archivo CSV no contiene datos.');

  const separador = detectarSeparador(lineas[0]);
  const encabezados = partirLineaCsv(lineas[0], separador).map((h) => h.replace(/^"|"$/g, ''));

  const filas: FilaCruda[] = [];
  for (let i = 1; i < lineas.length; i += 1) {
    const campos = partirLineaCsv(lineas[i], separador);
    const valores: Record<string, unknown> = {};
    encabezados.forEach((encabezado, indice) => {
      const bruto = (campos[indice] ?? '').replace(/^"|"$/g, '');
      valores[encabezado] = bruto;
    });
    // Se descartan las filas completamente vacias.
    if (Object.values(valores).some((v) => String(v ?? '').trim() !== '')) {
      filas.push({ numero: i + 1, valores });
    }
  }

  return { encabezados, filas };
}

async function leerXlsx(contenido: Buffer): Promise<{ encabezados: string[]; filas: FilaCruda[] }> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(contenido as unknown as ArrayBuffer);

  const hoja = libro.worksheets[0];
  if (!hoja) throw errores.validacion('El archivo XLSX no contiene hojas de calculo.');

  const encabezados: string[] = [];
  const filaEncabezado = hoja.getRow(1);
  filaEncabezado.eachCell({ includeEmpty: false }, (celda, columna) => {
    encabezados[columna - 1] = String(celda.value ?? '').trim();
  });

  if (encabezados.filter(Boolean).length === 0) {
    throw errores.validacion('La primera fila del archivo debe contener los encabezados.');
  }

  const filas: FilaCruda[] = [];
  hoja.eachRow({ includeEmpty: false }, (fila, numero) => {
    if (numero === 1) return;
    const valores: Record<string, unknown> = {};
    let tieneContenido = false;

    encabezados.forEach((encabezado, indice) => {
      if (!encabezado) return;
      const celda = fila.getCell(indice + 1);
      let valor: unknown = celda.value;

      // Las celdas con formula se toman por su RESULTADO, nunca por su formula.
      if (valor && typeof valor === 'object') {
        const objeto = valor as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
        if ('result' in objeto) valor = objeto.result;
        else if (Array.isArray(objeto.richText)) valor = objeto.richText.map((t) => t.text).join('');
        else if ('text' in objeto) valor = objeto.text;
        else if (valor instanceof Date) valor = valor;
      }

      valores[encabezado] = valor;
      if (String(valor ?? '').trim() !== '') tieneContenido = true;
    });

    if (tieneContenido) filas.push({ numero, valores });
  });

  return { encabezados: encabezados.filter(Boolean), filas };
}

// ---------------------------------------------------------------------------
// Transformacion a filas canonicas
// ---------------------------------------------------------------------------

export interface OpcionesLectura {
  /** Año obligatorio cuando el archivo no lo trae (hoja de proyeccion). */
  anioForzado?: number;
  /** Serial del inversor cuando todo el archivo pertenece a un solo equipo. */
  serialUnico?: string | null;
  maxFilas: number;
}

export async function leerArchivo(
  contenido: Buffer,
  extension: '.csv' | '.xlsx',
  opciones: OpcionesLectura,
): Promise<ResultadoLectura> {
  const { encabezados, filas } =
    extension === '.csv' ? leerCsv(contenido) : await leerXlsx(contenido);

  if (filas.length === 0) {
    throw errores.validacion('El archivo no contiene filas de datos debajo de los encabezados.');
  }
  if (filas.length > opciones.maxFilas) {
    throw errores.validacion(
      `El archivo contiene ${filas.length} filas y el maximo permitido es ${opciones.maxFilas}. Divida el archivo en partes.`,
    );
  }

  const { formato, mapeo } = detectarFormato(encabezados);
  const problemas: ProblemaFila[] = [];
  const canonicas: FilaCanonica[] = [];
  const hoy = hoyISO();

  const leerCampo = (valores: Record<string, unknown>, clave: string): unknown => {
    const columna = mapeo[clave];
    return columna ? valores[columna] : undefined;
  };

  const textoDe = (valor: unknown): string | null => {
    if (valor === null || valor === undefined) return null;
    const texto = String(valor).trim();
    if (!texto) return null;
    if (detectarFormula(texto)) return neutralizarFormula(texto).slice(0, 500);
    return texto.slice(0, 500);
  };

  for (const fila of filas) {
    const errar = (columna: string | null, valor: unknown, codigo: string, mensaje: string) => {
      problemas.push({
        fila: fila.numero,
        columna,
        valor: valor === undefined || valor === null ? null : String(valor).slice(0, 255),
        codigo,
        severidad: 'ERROR',
        mensaje,
      });
    };

    if (formato === 'HISTORICO_EXCEL') {
      const planta = textoDe(leerCampo(fila.valores, 'planta'));
      const tipo = textoDe(leerCampo(fila.valores, 'tipo'));
      const anioBruto = leerCampo(fila.valores, 'anio');
      const mesBruto = leerCampo(fila.valores, 'mes');
      const generacionBruta = leerCampo(fila.valores, 'generacion');
      const comentarios = textoDe(leerCampo(fila.valores, 'comentarios'));
      const serial = textoDe(leerCampo(fila.valores, 'serial')) ?? opciones.serialUnico ?? null;

      if (!planta) {
        errar('Planta', anioBruto, 'PLANTA_VACIA', 'La columna Planta es obligatoria.');
        continue;
      }

      const anio = opciones.anioForzado ?? Number(parsearNumero(anioBruto));
      if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
        errar('Año', anioBruto, 'ANIO_INVALIDO', 'El año debe ser un entero valido entre 2000 y 2100.');
        continue;
      }

      const mes = normalizarMes(mesBruto);
      if (!mes) {
        errar(
          'Mes',
          mesBruto,
          'MES_INVALIDO',
          'El mes no se reconocio. Use el nombre en español (Enero...Diciembre) o un numero de 1 a 12.',
        );
        continue;
      }

      const generacion = parsearNumero(generacionBruta);
      if (generacion === null) {
        errar('Generacion', generacionBruta, 'KWH_NO_NUMERICO', 'La generacion debe ser un valor numerico en kWh.');
        continue;
      }
      if (generacion < 0) {
        errar(
          'Generacion',
          generacionBruta,
          'KWH_NEGATIVO',
          'No se aceptan valores de energia negativos.',
        );
        continue;
      }

      const fecha = `${anio}-${String(mes).padStart(2, '0')}-01`;
      if (fecha > hoy) {
        problemas.push({
          fila: fila.numero,
          columna: 'Mes',
          valor: `${mes}/${anio}`,
          codigo: 'PERIODO_FUTURO',
          severidad: 'ADVERTENCIA',
          mensaje: `El periodo ${MESES_ES[mes - 1]} ${anio} es futuro respecto de la fecha actual.`,
        });
      }

      canonicas.push({
        fila: fila.numero,
        planta,
        tipo,
        anio,
        mes,
        fecha,
        granularidad: 'MENSUAL',
        kwh: redondearKwh(generacion),
        serial,
        comentarios,
      });
      continue;
    }

    // --- Formato normalizado -------------------------------------------
    const fechaBruta = leerCampo(fila.valores, 'fecha');
    const kwhBruto = leerCampo(fila.valores, 'kwh');
    const serial = textoDe(leerCampo(fila.valores, 'serial')) ?? opciones.serialUnico ?? null;
    const comentarios = textoDe(leerCampo(fila.valores, 'comentarios'));

    const fecha = normalizarFecha(fechaBruta);
    if (!fecha || !esFechaISO(fecha)) {
      errar(
        'fecha',
        fechaBruta,
        'FECHA_INVALIDA',
        'La fecha no es valida. Use el formato aaaa-mm-dd o dd/mm/aaaa.',
      );
      continue;
    }
    if (fecha > hoy) {
      errar('fecha', fechaBruta, 'FECHA_FUTURA', 'No se acepta produccion con fecha futura.');
      continue;
    }

    const kwh = parsearNumero(kwhBruto);
    if (kwh === null) {
      errar('kwh', kwhBruto, 'KWH_NO_NUMERICO', 'El valor de kWh debe ser numerico.');
      continue;
    }
    if (kwh < 0) {
      errar('kwh', kwhBruto, 'KWH_NEGATIVO', 'No se aceptan valores de energia negativos.');
      continue;
    }

    canonicas.push({
      fila: fila.numero,
      planta: null,
      tipo: null,
      anio: Number(fecha.slice(0, 4)),
      mes: Number(fecha.slice(5, 7)),
      fecha,
      granularidad: 'DIARIA',
      kwh: redondearKwh(kwh),
      serial,
      comentarios,
    });
  }

  return {
    formato,
    encabezados,
    mapeoDetectado: mapeo,
    filas: canonicas,
    problemas,
    totalFilasLeidas: filas.length,
  };
}

// ---------------------------------------------------------------------------
// Agrupacion para el formato historico
// ---------------------------------------------------------------------------

export interface GrupoPeriodo {
  clave: string;
  planta: string;
  anio: number;
  mes: number;
  filas: FilaCanonica[];
  kwhTotal: number;
  tieneSerial: boolean;
  requiereDecision: boolean;
}

/**
 * Agrupa por planta/anio/mes. Varias filas del mismo grupo NO son duplicados
 * automaticos: cuando no traen identificador de inversor se marca
 * `requiereDecision` para que el usuario elija que hacer.
 */
export function agruparPorPeriodo(filas: FilaCanonica[]): GrupoPeriodo[] {
  const mapa = new Map<string, GrupoPeriodo>();

  for (const fila of filas) {
    const clave = `${fila.planta ?? ''}|${fila.anio}|${fila.mes}`;
    let grupo = mapa.get(clave);
    if (!grupo) {
      grupo = {
        clave,
        planta: fila.planta ?? '',
        anio: fila.anio,
        mes: fila.mes,
        filas: [],
        kwhTotal: 0,
        tieneSerial: false,
        requiereDecision: false,
      };
      mapa.set(clave, grupo);
    }
    grupo.filas.push(fila);
    grupo.kwhTotal = redondearKwh(grupo.kwhTotal + fila.kwh);
    if (fila.serial) grupo.tieneSerial = true;
  }

  for (const grupo of mapa.values()) {
    grupo.requiereDecision = grupo.filas.length > 1 && !grupo.tieneSerial;
  }

  return [...mapa.values()].sort(
    (a, b) => a.planta.localeCompare(b.planta) || a.anio - b.anio || a.mes - b.mes,
  );
}

// ---------------------------------------------------------------------------
// Generacion de plantillas
// ---------------------------------------------------------------------------

export function plantillaNormalizadaCsv(): string {
  return [
    'fecha,kwh,inversor_serial,comentarios',
    '2026-01-15,1250.5000,INV-DEMO-001,Lectura diaria del inversor',
    '2026-01-16,1310.2500,INV-DEMO-001,',
    '2026-01-17,980.0000,INV-DEMO-002,Dia nublado',
  ].join('\r\n');
}

export function plantillaHistoricaCsv(): string {
  return [
    'Planta,Tipo,Año,Mes,Generacion,Comentarios',
    'Planta Demo Norte,PPA,2025,Enero,45200.0000,Operacion normal',
    'Planta Demo Norte,PPA,2025,Febrero,41800.5000,',
    'Planta Demo Sur,EPC,2025,Enero,28750.0000,Mantenimiento programado el 12',
  ].join('\r\n');
}

export async function plantillaXlsx(formato: FormatoArchivo): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Sistema de Monitoreo Energetico - Retse, S.A.';
  libro.created = new Date();

  const hoja = libro.addWorksheet(formato === 'NORMALIZADO' ? 'Produccion' : 'Historico');

  if (formato === 'NORMALIZADO') {
    hoja.columns = [
      { header: 'fecha', key: 'fecha', width: 14 },
      { header: 'kwh', key: 'kwh', width: 14 },
      { header: 'inversor_serial', key: 'serial', width: 22 },
      { header: 'comentarios', key: 'comentarios', width: 40 },
    ];
    hoja.addRows([
      { fecha: '2026-01-15', kwh: 1250.5, serial: 'INV-DEMO-001', comentarios: 'Lectura diaria' },
      { fecha: '2026-01-16', kwh: 1310.25, serial: 'INV-DEMO-001', comentarios: '' },
      { fecha: '2026-01-17', kwh: 980, serial: 'INV-DEMO-002', comentarios: 'Dia nublado' },
    ]);
  } else {
    hoja.columns = [
      { header: 'Planta', key: 'planta', width: 28 },
      { header: 'Tipo', key: 'tipo', width: 10 },
      { header: 'Año', key: 'anio', width: 10 },
      { header: 'Mes', key: 'mes', width: 14 },
      { header: 'Generacion', key: 'generacion', width: 16 },
      { header: 'Comentarios', key: 'comentarios', width: 40 },
    ];
    hoja.addRows([
      { planta: 'Planta Demo Norte', tipo: 'PPA', anio: 2025, mes: 'Enero', generacion: 45200, comentarios: 'Operacion normal' },
      { planta: 'Planta Demo Norte', tipo: 'PPA', anio: 2025, mes: 'Febrero', generacion: 41800.5, comentarios: '' },
      { planta: 'Planta Demo Sur', tipo: 'EPC', anio: 2025, mes: 'Enero', generacion: 28750, comentarios: '' },
    ]);
  }

  hoja.getRow(1).font = { bold: true };
  hoja.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0B3C5D' },
  };
  hoja.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const instrucciones = libro.addWorksheet('Instrucciones');
  instrucciones.columns = [{ width: 110 }];
  const lineas =
    formato === 'NORMALIZADO'
      ? [
          'PLANTILLA NORMALIZADA DE PRODUCCION',
          '',
          'fecha            Obligatoria. Formato aaaa-mm-dd o dd/mm/aaaa. No se aceptan fechas futuras.',
          'kwh              Obligatoria. Energia generada en kWh (no kWp). Punto o coma decimal. No negativa.',
          'inversor_serial  Opcional si en el asistente ya selecciono un inversor para todo el archivo.',
          'comentarios      Opcional. Maximo 500 caracteres.',
          '',
          'No incluya formulas ni macros. El sistema toma el resultado de la celda, nunca la formula.',
        ]
      : [
          'PLANTILLA HISTORICA (COMPATIBLE CON EL EXCEL EXISTENTE)',
          '',
          'Planta       Obligatoria. Debe coincidir con el nombre del proyecto registrado.',
          'Tipo         Opcional. Modalidad comercial: PPA, EPC o EDS.',
          'Año          Obligatorio. Entero entre 2000 y 2100.',
          'Mes          Obligatorio. Nombre en español (Enero..Diciembre) o numero de 1 a 12.',
          'Generacion   Obligatoria. Energia mensual en kWh. No negativa.',
          'Comentarios  Opcional.',
          'Inversor     Columna adicional recomendada para cargas futuras por dispositivo.',
          '',
          'Si una misma planta tiene varias filas para el mismo mes sin identificador de inversor,',
          'el asistente le pedira decidir: sumarlas como componentes del consolidado, mapearlas',
          'a un inversor o rechazar el grupo para corregir el archivo.',
        ];
  lineas.forEach((linea) => instrucciones.addRow([linea]));
  instrucciones.getRow(1).font = { bold: true, size: 13 };

  const buffer = await libro.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Archivo de ejemplo con errores deliberados para demostrar la validacion. */
export function plantillaConErroresCsv(): string {
  return [
    'Planta,Tipo,Año,Mes,Generacion,Comentarios',
    'Planta Demo Norte,PPA,2025,Enero,45200,Fila valida',
    'Planta Demo Norte,PPA,1899,Febrero,41800,Año fuera de rango',
    'Planta Demo Norte,PPA,2025,Trecemberre,1000,Mes inexistente',
    'Planta Demo Norte,PPA,2025,Marzo,abc,Generacion no numerica',
    'Planta Demo Norte,PPA,2025,Abril,-500,Generacion negativa',
    ',PPA,2025,Mayo,1000,Planta vacia',
    'Planta Inexistente XYZ,PPA,2025,Junio,1000,Planta no registrada',
    'Planta Demo Norte,PPA,2025,Julio,=1+1,Intento de formula',
    'Planta Demo Norte,PPA,2025,Agosto,12000,Fila valida',
    'Planta Demo Norte,PPA,2025,Agosto,3000,Segunda fila del mismo mes (requiere decision)',
  ].join('\r\n');
}
