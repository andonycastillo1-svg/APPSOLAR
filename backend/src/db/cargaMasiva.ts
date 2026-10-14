import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { trimestreActual } from '../utils/fechas';

/**
 * Carga masiva de la estructura del negocio: clientes, proyectos, grupos e
 * inversores. Un libro de Excel se convierte en un script SQL que se puede
 * ejecutar en phpMyAdmin (hosting) o en cualquier cliente MySQL/MariaDB.
 *
 *   npm run db:plantilla-carga                       -> database/seeds/plantilla_carga_masiva.xlsx
 *   npm run db:carga-masiva -- mi_archivo.xlsx       -> mi_archivo.sql
 *
 * El script es IDEMPOTENTE (se puede ejecutar mas de una vez sin duplicar):
 * clientes por NIT, proyectos por nombre, grupos por proyecto+nombre e
 * inversores por proyecto+serie. Corre dentro de una transaccion.
 *
 * Este modulo no se conecta a la base de datos: solo lee el Excel y escribe SQL.
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface ClienteCarga {
  fila: number;
  nombre: string;
  nit: string;
  ubicacion: string | null;
  contacto: string | null;
  telefono: string | null;
  email: string | null;
  activo: boolean;
}
export interface ProyectoCarga {
  fila: number;
  nitCliente: string;
  nombre: string;
  ubicacion: string | null;
  modalidad: 'PPA' | 'EPC' | 'EDS';
  suministradora: 'DISTRIBUIDORA' | 'COMERCIALIZADORA';
  tipoTarifa: string;
  /** Solo comercializadora: valor del kWh pactado, fijo. */
  valorPactadoKwh: number | null;
  /** Solo distribuidora: tarifa del trimestre en curso (opcional). */
  tarifaVigenteKwh: number | null;
  capacidadKwp: number | null;
  fechaInicio: string | null;
  observaciones: string | null;
}
export interface GrupoCarga {
  fila: number;
  proyecto: string;
  nombre: string;
  cantidadInversores: number | null;
  tieneBaterias: boolean;
  capacidadBateriasKwh: number | null;
  capacidadKwp: number | null;
  ubicacion: string | null;
  observaciones: string | null;
}
export interface InversorCarga {
  fila: number;
  proyecto: string;
  grupo: string;
  marca: string;
  modelo: string;
  conexion: 'MANUAL' | 'HUAWEI_API';
  serie: string | null;
  estacion: string | null;
  capacidadKwp: number | null;
  estado: 'ACTIVO' | 'INACTIVO' | 'MANTENIMIENTO';
  observaciones: string | null;
}
export interface DatosCarga {
  clientes: ClienteCarga[];
  proyectos: ProyectoCarga[];
  grupos: GrupoCarga[];
  inversores: InversorCarga[];
}
export interface Problema {
  hoja: string;
  fila: number;
  mensaje: string;
}
export interface ResultadoLectura {
  datos: DatosCarga;
  errores: Problema[];
  avisos: Problema[];
}

const MODALIDADES = ['PPA', 'EPC', 'EDS'] as const;
const CONEXIONES = ['MANUAL', 'HUAWEI_API'] as const;
const ESTADOS = ['ACTIVO', 'INACTIVO', 'MANTENIMIENTO'] as const;
const PATRON_NIT = /^[0-9]{4,12}-?[0-9kK]$/;

// ---------------------------------------------------------------------------
// Definicion de la plantilla (columnas por hoja)
// ---------------------------------------------------------------------------

interface Columna {
  clave: string;
  titulo: string;
  ancho: number;
  alias?: string[];
  ayuda: string;
  lista?: readonly string[];
}

/** Catalogo de tipos de tarifa (el mismo que siembra la migracion 010). */
export const TIPOS_TARIFA = [
  'TS', 'BTSA', 'AP', 'APPN', 'VSC', 'BTDA', 'MTDA', 'BTHD', 'BTSH', 'MTHD', 'PBT', 'PMT',
] as const;
const SUMINISTRADORAS = ['DISTRIBUIDORA', 'COMERCIALIZADORA'] as const;

const COLUMNAS: Record<'Clientes' | 'Proyectos' | 'Grupos' | 'Inversores', Columna[]> = {
  Clientes: [
    { clave: 'nombre', titulo: 'Cliente *', ancho: 34, alias: ['nombre', 'cliente'], ayuda: 'Nombre del cliente (3 a 160 caracteres).' },
    { clave: 'nit', titulo: 'NIT *', ancho: 16, ayuda: 'NIT del cliente. Es la llave: no se repite.' },
    { clave: 'ubicacion', titulo: 'Ubicación', ancho: 30, ayuda: 'Dirección o municipio.' },
    { clave: 'contacto', titulo: 'Contacto', ancho: 24, ayuda: 'Persona de contacto.' },
    { clave: 'telefono', titulo: 'Teléfono', ancho: 16, ayuda: 'Teléfono de contacto.' },
    { clave: 'email', titulo: 'Correo', ancho: 28, alias: ['correo', 'email', 'correo electronico'], ayuda: 'Correo electrónico.' },
    { clave: 'activo', titulo: 'Activo', ancho: 10, lista: ['SI', 'NO'], ayuda: 'SI por defecto.' },
  ],
  Proyectos: [
    { clave: 'nitCliente', titulo: 'NIT del cliente *', ancho: 18, alias: ['nit del cliente', 'nit cliente', 'cliente nit', 'nit'], ayuda: 'NIT de un cliente de la hoja Clientes.' },
    { clave: 'nombre', titulo: 'Proyecto *', ancho: 34, alias: ['proyecto', 'planta', 'nombre'], ayuda: 'Nombre de la planta. Es la llave: no se repite.' },
    { clave: 'ubicacion', titulo: 'Ubicación', ancho: 30, ayuda: 'Dirección o municipio de la planta.' },
    { clave: 'modalidad', titulo: 'Modalidad *', ancho: 12, alias: ['modalidad', 'tipo', 'tipo de proyecto'], lista: MODALIDADES, ayuda: 'PPA, EPC o EDS.' },
    { clave: 'suministradora', titulo: 'Suministradora *', ancho: 20, alias: ['suministradora', 'suministro'], lista: SUMINISTRADORAS, ayuda: 'DISTRIBUIDORA (PPA) o COMERCIALIZADORA (EPC). EDS puede ser cualquiera.' },
    { clave: 'tipoTarifa', titulo: 'Tipo de tarifa *', ancho: 16, alias: ['tipo de tarifa', 'tarifa', 'sigla de tarifa'], lista: TIPOS_TARIFA, ayuda: 'Sigla del tipo de tarifa (BTDA, MTHD, TS...).' },
    { clave: 'valorPactadoKwh', titulo: 'Valor pactado (Q/kWh)', ancho: 20, alias: ['valor pactado q kwh', 'valor pactado', 'tarifa pactada'], ayuda: 'Solo COMERCIALIZADORA (obligatorio): valor fijo del contrato.' },
    { clave: 'tarifaVigenteKwh', titulo: 'Tarifa trimestre en curso (Q/kWh)', ancho: 24, alias: ['tarifa trimestre en curso q kwh', 'tarifa trimestre en curso', 'tarifa vigente'], ayuda: 'Solo DISTRIBUIDORA (opcional): tarifa del trimestre actual. Se renueva cada trimestre desde el sistema.' },
    { clave: 'capacidadKwp', titulo: 'Potencia instalada (kWp)', ancho: 22, alias: ['potencia instalada kwp', 'potencia kwp', 'kwp', 'capacidad kwp'], ayuda: 'Potencia en kWp (no kWh).' },
    { clave: 'fechaInicio', titulo: 'Fecha de inicio', ancho: 16, alias: ['fecha de inicio', 'fecha inicio'], ayuda: 'Formato aaaa-mm-dd.' },
    { clave: 'observaciones', titulo: 'Observaciones', ancho: 34, ayuda: 'Notas (hasta 500 caracteres).' },
  ],
  Grupos: [
    { clave: 'proyecto', titulo: 'Proyecto *', ancho: 34, alias: ['proyecto', 'planta'], ayuda: 'Nombre exacto de un proyecto de la hoja Proyectos.' },
    { clave: 'nombre', titulo: 'Grupo *', ancho: 24, alias: ['grupo', 'nombre'], ayuda: 'Nombre del grupo (único dentro del proyecto).' },
    { clave: 'cantidadInversores', titulo: 'Cantidad de inversores', ancho: 22, alias: ['cantidad de inversores', 'inversores'], ayuda: 'Cuántos inversores debería tener el grupo.' },
    { clave: 'tieneBaterias', titulo: 'Banco de baterías', ancho: 18, alias: ['banco de baterias', 'baterias'], lista: ['SI', 'NO'], ayuda: 'SI o NO.' },
    { clave: 'capacidadBateriasKwh', titulo: 'Capacidad baterías (kWh)', ancho: 22, alias: ['capacidad baterias kwh', 'capacidad de baterias kwh'], ayuda: 'Solo si tiene banco de baterías.' },
    { clave: 'capacidadKwp', titulo: 'Potencia (kWp)', ancho: 16, alias: ['potencia kwp', 'kwp', 'potencia'], ayuda: 'Potencia del grupo en kWp.' },
    { clave: 'ubicacion', titulo: 'Ubicación', ancho: 26, ayuda: 'Ubicación dentro de la planta.' },
    { clave: 'observaciones', titulo: 'Observaciones', ancho: 30, ayuda: 'Notas.' },
  ],
  Inversores: [
    { clave: 'proyecto', titulo: 'Proyecto *', ancho: 34, alias: ['proyecto', 'planta'], ayuda: 'Nombre exacto del proyecto.' },
    { clave: 'grupo', titulo: 'Grupo *', ancho: 24, alias: ['grupo'], ayuda: 'Nombre exacto de un grupo de ese proyecto (hoja Grupos).' },
    { clave: 'marca', titulo: 'Marca *', ancho: 16, ayuda: 'Por ejemplo Huawei.' },
    { clave: 'modelo', titulo: 'Modelo *', ancho: 20, ayuda: 'Por ejemplo SUN2000-100KTL.' },
    { clave: 'conexion', titulo: 'Conexión *', ancho: 14, alias: ['conexion', 'tipo de conexion'], lista: CONEXIONES, ayuda: 'HUAWEI_API para sincronizar con Huawei; MANUAL en otro caso.' },
    { clave: 'serie', titulo: 'Número de serie', ancho: 22, alias: ['numero de serie', 'serie', 'serial', 'inversor serial'], ayuda: 'Obligatorio para HUAWEI_API. Es la llave dentro del proyecto.' },
    { clave: 'estacion', titulo: 'Estación Huawei (opcional)', ancho: 24, alias: ['estacion huawei opcional', 'estacion huawei', 'estacion'], ayuda: 'Normalmente se deja vacío: el sistema la descubre solo por la serie.' },
    { clave: 'capacidadKwp', titulo: 'Potencia (kWp)', ancho: 16, alias: ['potencia kwp', 'kwp', 'potencia'], ayuda: 'Potencia del inversor en kWp.' },
    { clave: 'estado', titulo: 'Estado', ancho: 16, lista: ESTADOS, ayuda: 'ACTIVO por defecto.' },
    { clave: 'observaciones', titulo: 'Observaciones', ancho: 30, ayuda: 'Notas.' },
  ],
};

const EJEMPLOS: Record<keyof typeof COLUMNAS, Array<Array<string | number>>> = {
  Clientes: [['EJEMPLO Cliente de prueba, S.A.', '1234567-8', 'Ciudad de Guatemala', 'Juan Pérez', '5555-0000', 'contacto@ejemplo.com', 'SI']],
  Proyectos: [['1234567-8', 'EJEMPLO Planta Norte', 'Escuintla', 'PPA', 'DISTRIBUIDORA', 'BTDA', '', 1.25, 250.5, '2025-03-01', 'Fila de ejemplo: bórrela']],
  Grupos: [['EJEMPLO Planta Norte', 'Grupo 1', 2, 'NO', '', 250.5, 'Techo principal', '']],
  Inversores: [['EJEMPLO Planta Norte', 'Grupo 1', 'Huawei', 'SUN2000-100KTL', 'HUAWEI_API', 'HV0000000000', '', 100, 'ACTIVO', '']],
};

// ---------------------------------------------------------------------------
// Generacion de la plantilla
// ---------------------------------------------------------------------------

export async function generarPlantillaCargaMasiva(): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Sistema de Monitoreo Energético - Retse, S.A.';
  libro.created = new Date();

  const instrucciones = libro.addWorksheet('Instrucciones');
  instrucciones.columns = [{ width: 120 }];
  [
    'PLANTILLA DE CARGA MASIVA — CLIENTES, PROYECTOS, GRUPOS E INVERSORES',
    '',
    'Complete las hojas en este orden: Clientes → Proyectos → Grupos → Inversores. Las columnas con asterisco (*) son obligatorias.',
    '',
    'Cómo se relacionan las hojas:',
    '  • Proyectos.NIT del cliente  debe ser el NIT de un cliente de la hoja Clientes.',
    '  • Grupos.Proyecto            debe ser el nombre exacto de un proyecto de la hoja Proyectos.',
    '  • Inversores.Proyecto y Grupo deben existir en las hojas Proyectos y Grupos (el grupo debe ser de ese proyecto).',
    '  • Todo inversor pertenece a un grupo: si la planta no tiene grupos, cree uno (por ejemplo «Grupo principal»).',
    '',
    'Reglas:',
    '  • Las filas cuyo primer dato empieza con la palabra EJEMPLO se ignoran: puede dejarlas o borrarlas.',
    '  • Suministradora: PPA trabaja con DISTRIBUIDORA y EPC con COMERCIALIZADORA (EDS puede ser cualquiera). El Tipo de tarifa es una sigla del catálogo.',
    '  • COMERCIALIZADORA exige Valor pactado (Q/kWh): es fijo y no se renueva. DISTRIBUIDORA puede traer la Tarifa del trimestre en curso (opcional).',
    '  • Los trimestres de la tarifa inician en noviembre: nov-ene, feb-abr, may-jul y ago-oct.',
    '  • Conexión HUAWEI_API exige Número de serie: con ese serial el sistema encuentra la estación y sincroniza solo.',
    '  • Potencias en kWp (no kWh). Fechas en formato aaaa-mm-dd. No use fórmulas: se toma el resultado de la celda.',
    '  • El NIT identifica al cliente, el nombre identifica al proyecto, y la serie al inversor: repetir la carga ACTUALIZA, no duplica.',
    '',
    'Qué hacer con el archivo:',
    '  1. Desde la carpeta backend ejecute:  npm run db:carga-masiva -- ruta\\a\\este_archivo.xlsx',
    '  2. El programa revisa todo y, si hay errores, le dice la hoja y la fila exactas. Si no hay errores genera un archivo .sql.',
    '  3. Haga un respaldo (Configuración → Respaldos) y luego ejecute el .sql en phpMyAdmin (pestaña SQL o Importar) sobre la base de la aplicación.',
    '  4. Entre al sistema y pulse «Sincronizar ahora»: los inversores HUAWEI_API se vinculan solos y se carga su historial.',
    '',
    'Después de cargar, falta (desde el sistema): las tarifas de los demás trimestres (distribuidora), la proyección anual de cada proyecto y los lotes de paneles.',
  ].forEach((linea) => instrucciones.addRow([linea]));
  instrucciones.getRow(1).font = { bold: true, size: 13 };

  (Object.keys(COLUMNAS) as Array<keyof typeof COLUMNAS>).forEach((hoja) => {
    const ws = libro.addWorksheet(hoja);
    ws.columns = COLUMNAS[hoja].map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }));
    const cab = ws.getRow(1);
    cab.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C5D' } };
    cab.height = 22;
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    COLUMNAS[hoja].forEach((c, i) => {
      cab.getCell(i + 1).note = c.ayuda;
    });

    EJEMPLOS[hoja].forEach((valores) => {
      const fila = ws.addRow(valores);
      fila.font = { italic: true, color: { argb: 'FF7F7F7F' } };
    });

    // Listas desplegables y formato para 500 filas.
    COLUMNAS[hoja].forEach((c, i) => {
      for (let f = 2; f <= 501; f += 1) {
        const celda = ws.getCell(f, i + 1);
        if (c.lista) {
          celda.dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: [`"${c.lista.join(',')}"`],
            showErrorMessage: true,
            errorTitle: 'Valor no válido',
            error: `Use uno de: ${c.lista.join(', ')}`,
          };
        }
        if (c.clave === 'nit' || c.clave === 'serie' || c.clave === 'telefono' || c.clave === 'nitCliente') {
          celda.numFmt = '@'; // texto: evita perder ceros o convertir a notacion cientifica
        }
      }
    });
  });

  return Buffer.from(await libro.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Lectura y validacion
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92);
function normalizar(texto: unknown): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(new RegExp('[' + BS + 'u0300-' + BS + 'u036f]', 'g'), '')
    .replace(/[*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s._()-]+/g, ' ')
    .trim();
}

function valorCelda(celda: ExcelJS.Cell): unknown {
  let v: unknown = celda.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }>; hyperlink?: string };
    if ('result' in o) v = o.result;
    else if (Array.isArray(o.richText)) v = o.richText.map((t) => t.text).join('');
    else if ('text' in o) v = o.text;
  }
  return v;
}

function texto(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = String(v).replace(/[\u0000-\u001f]+/g, ' ').trim();
  return t === '' ? null : t;
}

function numero(v: unknown): number | null | 'ERR' {
  const t = texto(v);
  if (t === null) return null;
  const compacto = t.replace(/\s/g, '');
  // Con punto y coma, la coma separa miles; con solo coma, es el separador decimal.
  const n = Number(compacto.includes('.') ? compacto.replace(/,/g, '') : compacto.replace(',', '.'));
  return Number.isFinite(n) ? n : 'ERR';
}

function fechaISO(v: unknown): string | null | 'ERR' {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) {
    const d = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
    if (d) m = [d[0], d[3], d[2].padStart(2, '0'), d[1].padStart(2, '0')] as unknown as RegExpExecArray;
  }
  if (!m) return 'ERR';
  const f = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return !Number.isNaN(f.getTime()) && f.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}`
    ? `${m[1]}-${m[2]}-${m[3]}`
    : 'ERR';
}

function siNo(v: unknown, porDefecto: boolean): boolean | 'ERR' {
  const t = texto(v);
  if (t === null) return porDefecto;
  const n = normalizar(t);
  if (['si', 's', '1', 'true', 'verdadero', 'x'].includes(n)) return true;
  if (['no', 'n', '0', 'false', 'falso'].includes(n)) return false;
  return 'ERR';
}

type Fila = Record<string, unknown> & { __fila: number };

function leerHoja(ws: ExcelJS.Worksheet | undefined, hoja: keyof typeof COLUMNAS, problemas: Problema[]): Fila[] {
  if (!ws) {
    problemas.push({ hoja, fila: 0, mensaje: `Falta la hoja "${hoja}". Use la plantilla original.` });
    return [];
  }
  const indice = new Map<string, number>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (celda, col) => {
    indice.set(normalizar(valorCelda(celda)), col);
  });

  const columnaDe = new Map<string, number>();
  for (const c of COLUMNAS[hoja]) {
    const candidatos = [normalizar(c.titulo), ...(c.alias ?? []).map(normalizar)];
    const col = candidatos.map((n) => indice.get(n)).find((x) => x !== undefined);
    if (col !== undefined) columnaDe.set(c.clave, col);
    else if (c.titulo.includes('*')) {
      problemas.push({ hoja, fila: 1, mensaje: `Falta la columna obligatoria "${c.titulo.replace(' *', '')}".` });
    }
  }

  const filas: Fila[] = [];
  ws.eachRow({ includeEmpty: false }, (fila, numeroFila) => {
    if (numeroFila === 1) return;
    const registro: Fila = { __fila: numeroFila };
    let hayDatos = false;
    for (const [clave, col] of columnaDe) {
      const v = valorCelda(fila.getCell(col));
      registro[clave] = v;
      if (texto(v) !== null) hayDatos = true;
    }
    if (!hayDatos) return;
    // Filas de ejemplo: la primera columna obligatoria empieza con EJEMPLO.
    const primeras = COLUMNAS[hoja].filter((c) => c.titulo.includes('*')).map((c) => texto(registro[c.clave]) ?? '');
    if (primeras.some((p) => /^ejemplo\b/i.test(p))) return;
    filas.push(registro);
  });
  return filas;
}

export async function leerCargaMasiva(contenido: Buffer): Promise<ResultadoLectura> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(contenido as unknown as ArrayBuffer);

  const errores: Problema[] = [];
  const avisos: Problema[] = [];
  const datos: DatosCarga = { clientes: [], proyectos: [], grupos: [], inversores: [] };
  const err = (hoja: string, fila: number, mensaje: string) => errores.push({ hoja, fila, mensaje });
  const aviso = (hoja: string, fila: number, mensaje: string) => avisos.push({ hoja, fila, mensaje });

  const largo = (hoja: string, fila: number, campo: string, valor: string | null, min: number, max: number, obligatorio: boolean): string | null => {
    if (valor === null) {
      if (obligatorio) err(hoja, fila, `${campo} es obligatorio.`);
      return null;
    }
    if (valor.length < min || valor.length > max) {
      err(hoja, fila, `${campo} debe tener entre ${min} y ${max} caracteres.`);
    }
    return valor;
  };
  const opcionalNumero = (hoja: string, fila: number, campo: string, v: unknown, maximo = 1e9): number | null => {
    const n = numero(v);
    if (n === 'ERR') {
      err(hoja, fila, `${campo} debe ser un número.`);
      return null;
    }
    if (n !== null && (n < 0 || n > maximo)) {
      err(hoja, fila, `${campo} debe estar entre 0 y ${maximo}.`);
      return null;
    }
    return n;
  };

  // ---------------- Clientes ----------------
  const nitsVistos = new Set<string>();
  for (const r of leerHoja(libro.getWorksheet('Clientes'), 'Clientes', errores)) {
    const f = r.__fila;
    const nombre = largo('Clientes', f, 'Cliente', texto(r.nombre), 3, 160, true);
    const nit = largo('Clientes', f, 'NIT', texto(r.nit), 4, 30, true);
    const email = texto(r.email)?.toLowerCase() ?? null;
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160)) err('Clientes', f, 'El correo no es válido.');
    if (nit) {
      if (!PATRON_NIT.test(nit)) aviso('Clientes', f, `El NIT "${nit}" no tiene el formato usual (números y dígito verificador). Revíselo.`);
      const k = nit.toLowerCase();
      if (nitsVistos.has(k)) err('Clientes', f, `El NIT ${nit} está repetido en la hoja.`);
      nitsVistos.add(k);
    }
    const activo = siNo(r.activo, true);
    if (activo === 'ERR') err('Clientes', f, 'Activo debe ser SI o NO.');
    for (const [campo, max] of [['ubicacion', 255], ['contacto', 120], ['telefono', 40]] as const) {
      const t = texto(r[campo]);
      if (t && t.length > max) err('Clientes', f, `${campo} supera los ${max} caracteres.`);
    }
    if (nombre && nit) {
      datos.clientes.push({
        fila: f, nombre, nit,
        ubicacion: texto(r.ubicacion), contacto: texto(r.contacto), telefono: texto(r.telefono),
        email, activo: activo === 'ERR' ? true : activo,
      });
    }
  }

  // ---------------- Proyectos ----------------
  const nombresProyecto = new Map<string, string>(); // normalizado -> nombre original
  for (const r of leerHoja(libro.getWorksheet('Proyectos'), 'Proyectos', errores)) {
    const f = r.__fila;
    const nitCliente = texto(r.nitCliente);
    const nombre = largo('Proyectos', f, 'Proyecto', texto(r.nombre), 3, 160, true);
    const modalidad = (texto(r.modalidad) ?? '').toUpperCase();
    if (!nitCliente) err('Proyectos', f, 'El NIT del cliente es obligatorio.');
    else if (!nitsVistos.has(nitCliente.toLowerCase())) {
      err('Proyectos', f, `El NIT ${nitCliente} no existe en la hoja Clientes.`);
    }
    if (!(MODALIDADES as readonly string[]).includes(modalidad)) err('Proyectos', f, 'La modalidad debe ser PPA, EPC o EDS.');

    // Suministradora: PPA -> distribuidora, EPC -> comercializadora.
    const suministradora = (texto(r.suministradora) ?? '').toUpperCase();
    const tipoTarifa = (texto(r.tipoTarifa) ?? '').toUpperCase();
    const suministroValido = (SUMINISTRADORAS as readonly string[]).includes(suministradora);
    if (!suministroValido) err('Proyectos', f, 'La suministradora debe ser DISTRIBUIDORA o COMERCIALIZADORA.');
    else if (modalidad === 'PPA' && suministradora !== 'DISTRIBUIDORA') {
      err('Proyectos', f, 'Un proyecto PPA trabaja siempre con DISTRIBUIDORA.');
    } else if (modalidad === 'EPC' && suministradora !== 'COMERCIALIZADORA') {
      err('Proyectos', f, 'Un proyecto EPC trabaja siempre con COMERCIALIZADORA.');
    }
    const tipoTarifaValido = (TIPOS_TARIFA as readonly string[]).includes(tipoTarifa);
    if (!tipoTarifaValido) {
      err('Proyectos', f, `El tipo de tarifa debe ser una sigla del catálogo (${TIPOS_TARIFA.join(', ')}).`);
    }
    const valorPactado = opcionalNumero('Proyectos', f, 'Valor pactado', r.valorPactadoKwh);
    const tarifaVigente = opcionalNumero('Proyectos', f, 'Tarifa del trimestre en curso', r.tarifaVigenteKwh);
    if (suministradora === 'COMERCIALIZADORA' && valorPactado === null) {
      err('Proyectos', f, 'Una comercializadora necesita su valor pactado (Q por kWh).');
    }
    if (suministradora === 'DISTRIBUIDORA' && valorPactado !== null) {
      err('Proyectos', f, 'El valor pactado solo aplica a COMERCIALIZADORA; en distribuidora la tarifa se renueva por trimestre.');
    }
    if (suministradora === 'COMERCIALIZADORA' && tarifaVigente !== null) {
      err('Proyectos', f, 'La tarifa del trimestre en curso solo aplica a DISTRIBUIDORA.');
    }
    const kwp = opcionalNumero('Proyectos', f, 'Potencia instalada', r.capacidadKwp);
    const fecha = fechaISO(r.fechaInicio);
    if (fecha === 'ERR') err('Proyectos', f, 'La fecha de inicio debe tener formato aaaa-mm-dd.');
    const obs = texto(r.observaciones);
    if (obs && obs.length > 500) err('Proyectos', f, 'Las observaciones superan los 500 caracteres.');
    const ubic = texto(r.ubicacion);
    if (ubic && ubic.length > 255) err('Proyectos', f, 'La ubicación supera los 255 caracteres.');
    if (nombre) {
      const k = normalizar(nombre);
      if (nombresProyecto.has(k)) err('Proyectos', f, `El proyecto "${nombre}" está repetido en la hoja.`);
      nombresProyecto.set(k, nombre);
    }
    if (nitCliente && nombre && (MODALIDADES as readonly string[]).includes(modalidad) && suministroValido && tipoTarifaValido) {
      datos.proyectos.push({
        fila: f, nitCliente, nombre, ubicacion: ubic, modalidad: modalidad as ProyectoCarga['modalidad'],
        suministradora: suministradora as ProyectoCarga['suministradora'], tipoTarifa,
        valorPactadoKwh: valorPactado, tarifaVigenteKwh: tarifaVigente,
        capacidadKwp: kwp, fechaInicio: fecha === 'ERR' ? null : fecha, observaciones: obs,
      });
    }
  }

  // ---------------- Grupos ----------------
  const gruposPorProyecto = new Map<string, Set<string>>(); // proyecto normalizado -> grupos normalizados
  for (const r of leerHoja(libro.getWorksheet('Grupos'), 'Grupos', errores)) {
    const f = r.__fila;
    const proyecto = texto(r.proyecto);
    const nombre = largo('Grupos', f, 'Grupo', texto(r.nombre), 2, 120, true);
    if (!proyecto) err('Grupos', f, 'El proyecto es obligatorio.');
    else if (!nombresProyecto.has(normalizar(proyecto))) err('Grupos', f, `El proyecto "${proyecto}" no existe en la hoja Proyectos.`);
    const cantidad = numero(r.cantidadInversores);
    if (cantidad === 'ERR' || (cantidad !== null && (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > 2000))) {
      err('Grupos', f, 'La cantidad de inversores debe ser un entero entre 0 y 2000.');
    }
    const baterias = siNo(r.tieneBaterias, false);
    if (baterias === 'ERR') err('Grupos', f, 'Banco de baterías debe ser SI o NO.');
    const kwhBat = opcionalNumero('Grupos', f, 'Capacidad de baterías', r.capacidadBateriasKwh);
    if (kwhBat !== null && baterias !== true) err('Grupos', f, 'No puede indicar capacidad de baterías si el grupo no tiene banco (Banco de baterías = SI).');
    const kwp = opcionalNumero('Grupos', f, 'Potencia', r.capacidadKwp);
    if (proyecto && nombre) {
      const kp = normalizar(proyecto);
      const set = gruposPorProyecto.get(kp) ?? new Set<string>();
      if (set.has(normalizar(nombre))) err('Grupos', f, `El grupo "${nombre}" está repetido en el proyecto "${proyecto}".`);
      set.add(normalizar(nombre));
      gruposPorProyecto.set(kp, set);
      if (nombresProyecto.has(kp)) {
        datos.grupos.push({
          fila: f, proyecto: nombresProyecto.get(kp)!, nombre,
          cantidadInversores: cantidad === 'ERR' ? null : cantidad,
          tieneBaterias: baterias === true, capacidadBateriasKwh: kwhBat, capacidadKwp: kwp,
          ubicacion: texto(r.ubicacion), observaciones: texto(r.observaciones),
        });
      }
    }
  }

  // ---------------- Inversores ----------------
  const seriesVistas = new Set<string>();
  for (const r of leerHoja(libro.getWorksheet('Inversores'), 'Inversores', errores)) {
    const f = r.__fila;
    const proyecto = texto(r.proyecto);
    const grupo = texto(r.grupo);
    const marca = largo('Inversores', f, 'Marca', texto(r.marca), 2, 60, true);
    const modelo = largo('Inversores', f, 'Modelo', texto(r.modelo), 1, 80, true);
    const conexion = (texto(r.conexion) ?? '').toUpperCase();
    const estado = (texto(r.estado) ?? 'ACTIVO').toUpperCase();
    const serie = largo('Inversores', f, 'Número de serie', texto(r.serie), 1, 80, false);
    const estacion = largo('Inversores', f, 'Estación', texto(r.estacion), 1, 80, false);
    if (!proyecto) err('Inversores', f, 'El proyecto es obligatorio.');
    else if (!nombresProyecto.has(normalizar(proyecto))) err('Inversores', f, `El proyecto "${proyecto}" no existe en la hoja Proyectos.`);
    if (!grupo) err('Inversores', f, 'El grupo es obligatorio (todo inversor pertenece a un grupo).');
    else if (proyecto && nombresProyecto.has(normalizar(proyecto)) && !gruposPorProyecto.get(normalizar(proyecto))?.has(normalizar(grupo))) {
      err('Inversores', f, `El grupo "${grupo}" no existe en el proyecto "${proyecto}" (hoja Grupos).`);
    }
    if (!(CONEXIONES as readonly string[]).includes(conexion)) err('Inversores', f, 'La conexión debe ser MANUAL o HUAWEI_API.');
    if (conexion === 'HUAWEI_API' && !serie) err('Inversores', f, 'Un inversor HUAWEI_API necesita su número de serie.');
    if (!(ESTADOS as readonly string[]).includes(estado)) err('Inversores', f, 'El estado debe ser ACTIVO, INACTIVO o MANTENIMIENTO.');
    const kwp = opcionalNumero('Inversores', f, 'Potencia', r.capacidadKwp);
    const obs = texto(r.observaciones);
    if (obs && obs.length > 500) err('Inversores', f, 'Las observaciones superan los 500 caracteres.');
    if (proyecto && serie) {
      const k = `${normalizar(proyecto)}|${serie.toLowerCase()}`;
      if (seriesVistas.has(k)) err('Inversores', f, `La serie ${serie} está repetida en el proyecto "${proyecto}".`);
      seriesVistas.add(k);
    }
    if (
      proyecto && grupo && marca && modelo &&
      (CONEXIONES as readonly string[]).includes(conexion) &&
      (ESTADOS as readonly string[]).includes(estado) &&
      nombresProyecto.has(normalizar(proyecto))
    ) {
      datos.inversores.push({
        fila: f, proyecto: nombresProyecto.get(normalizar(proyecto))!, grupo, marca, modelo,
        conexion: conexion as InversorCarga['conexion'], serie, estacion, capacidadKwp: kwp,
        estado: estado as InversorCarga['estado'], observaciones: obs,
      });
    }
  }

  // Avisos de coherencia: inversores declarados vs. cargados por grupo.
  for (const g of datos.grupos) {
    if (g.cantidadInversores === null) continue;
    const cargados = datos.inversores.filter(
      (i) => normalizar(i.proyecto) === normalizar(g.proyecto) && normalizar(i.grupo) === normalizar(g.nombre),
    ).length;
    if (cargados !== g.cantidadInversores) {
      aviso('Grupos', g.fila, `El grupo "${g.nombre}" declara ${g.cantidadInversores} inversor(es) y la hoja Inversores trae ${cargados}.`);
    }
  }
  if (datos.clientes.length + datos.proyectos.length + datos.grupos.length + datos.inversores.length === 0) {
    err('Archivo', 0, 'El archivo no tiene filas para cargar (las filas EJEMPLO se ignoran).');
  }

  return { datos, errores, avisos };
}

// ---------------------------------------------------------------------------
// Generacion del SQL
// ---------------------------------------------------------------------------

/** Literal SQL seguro: texto entre comillas con barra invertida y comilla escapadas. */
export function literal(valor: string | number | boolean | null): string {
  if (valor === null || valor === undefined) return 'NULL';
  if (typeof valor === 'boolean') return valor ? '1' : '0';
  if (typeof valor === 'number') return String(Math.round(valor * 1e6) / 1e6);
  const limpio = valor.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return `'${limpio.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function generarSql(datos: DatosCarga, origen = 'carga masiva'): string {
  const l = literal;
  const out: string[] = [];
  const nl = (s = '') => out.push(s);

  nl('-- =====================================================================');
  nl(`-- ${origen}  |  generado ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  nl(`-- ${datos.clientes.length} cliente(s), ${datos.proyectos.length} proyecto(s), ${datos.grupos.length} grupo(s), ${datos.inversores.length} inversor(es)`);
  nl('-- Es seguro ejecutarlo mas de una vez: actualiza, no duplica.');
  nl('-- IMPORTANTE: haga un respaldo antes (Configuracion > Respaldos).');
  nl('-- =====================================================================');
  nl('SET NAMES utf8mb4;');
  nl('START TRANSACTION;');
  nl();

  nl('-- ---------------------------- CLIENTES (llave: NIT) ----------------------------');
  for (const c of datos.clientes) {
    nl(`INSERT INTO clientes (nombre, nit, ubicacion, contacto, telefono, email, activo)`);
    nl(`VALUES (${l(c.nombre)}, ${l(c.nit)}, ${l(c.ubicacion)}, ${l(c.contacto)}, ${l(c.telefono)}, ${l(c.email)}, ${l(c.activo)})`);
    nl(`ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), ubicacion = VALUES(ubicacion), contacto = VALUES(contacto),`);
    nl(`  telefono = VALUES(telefono), email = VALUES(email), activo = VALUES(activo);`);
  }
  nl();

  nl('-- ------------------------- PROYECTOS (llave: nombre) -------------------------');
  for (const p of datos.proyectos) {
    const valorPactado = p.suministradora === 'COMERCIALIZADORA' ? p.valorPactadoKwh : null;
    nl(`INSERT INTO proyectos (id_cliente, nombre, ubicacion, tipo_proyecto, suministradora, id_tipo_tarifa, valor_pactado_kwh, capacidad_kwp, fecha_inicio, observaciones, activo)`);
    nl(`SELECT c.id_cliente, ${l(p.nombre)}, ${l(p.ubicacion)}, ${l(p.modalidad)}, ${l(p.suministradora)},`);
    nl(`       (SELECT t.id_tipo_tarifa FROM tipos_tarifa t WHERE t.sigla = ${l(p.tipoTarifa)}), ${l(valorPactado)},`);
    nl(`       ${l(p.capacidadKwp)}, ${l(p.fechaInicio)}, ${l(p.observaciones)}, 1`);
    nl(`  FROM clientes c WHERE c.nit = ${l(p.nitCliente)}`);
    nl(`ON DUPLICATE KEY UPDATE ubicacion = VALUES(ubicacion), tipo_proyecto = VALUES(tipo_proyecto),`);
    nl(`  suministradora = VALUES(suministradora), id_tipo_tarifa = VALUES(id_tipo_tarifa),`);
    nl(`  valor_pactado_kwh = VALUES(valor_pactado_kwh),`);
    nl(`  capacidad_kwp = VALUES(capacidad_kwp), fecha_inicio = VALUES(fecha_inicio), observaciones = VALUES(observaciones);`);
    // Distribuidora: tarifa del trimestre en curso (solo si aun no existe una vigente).
    if (p.suministradora === 'DISTRIBUIDORA' && p.tarifaVigenteKwh !== null) {
      const vigente = trimestreActual();
      nl(`INSERT INTO tarifas_kwh (id_proyecto, anio, trimestre, mes, costo_kwh, moneda, estado, origen, motivo, fecha_aprobacion)`);
      nl(`SELECT p.id_proyecto, ${vigente.anio}, ${vigente.trimestre}, NULL, ${l(p.tarifaVigenteKwh)}, 'GTQ', 'APROBADA', 'IMPORTACION', 'Carga masiva', NOW()`);
      nl(`  FROM proyectos p WHERE p.nombre = ${l(p.nombre)}`);
      nl(`   AND NOT EXISTS (SELECT 1 FROM tarifas_kwh t WHERE t.id_proyecto = p.id_proyecto`);
      nl(`                    AND t.anio = ${vigente.anio} AND t.trimestre = ${vigente.trimestre} AND t.estado <> 'ANULADA');`);
    }
  }
  nl();

  nl('-- --------------------- GRUPOS (llave: proyecto + nombre) ---------------------');
  for (const g of datos.grupos) {
    nl(`INSERT INTO grupos (id_proyecto, nombre, cantidad_inversores_declarada, tiene_banco_baterias, capacidad_baterias_kwh, capacidad_kwp, ubicacion, observaciones, activo)`);
    nl(`SELECT p.id_proyecto, ${l(g.nombre)}, ${l(g.cantidadInversores)}, ${l(g.tieneBaterias)}, ${l(g.tieneBaterias ? g.capacidadBateriasKwh : null)}, ${l(g.capacidadKwp)}, ${l(g.ubicacion)}, ${l(g.observaciones)}, 1`);
    nl(`  FROM proyectos p WHERE p.nombre = ${l(g.proyecto)}`);
    nl(`ON DUPLICATE KEY UPDATE cantidad_inversores_declarada = VALUES(cantidad_inversores_declarada),`);
    nl(`  tiene_banco_baterias = VALUES(tiene_banco_baterias), capacidad_baterias_kwh = VALUES(capacidad_baterias_kwh),`);
    nl(`  capacidad_kwp = VALUES(capacidad_kwp), ubicacion = VALUES(ubicacion), observaciones = VALUES(observaciones);`);
  }
  nl();

  nl('-- ---------------- INVERSORES (llave: proyecto + numero de serie) ----------------');
  for (const i of datos.inversores) {
    const idApi =
      i.conexion === 'HUAWEI_API'
        ? `(SELECT a.id_api FROM apis_fabricante a WHERE a.marca = 'HUAWEI' ORDER BY a.id_api LIMIT 1)`
        : 'NULL';
    nl(`INSERT INTO inversores (id_proyecto, id_grupo, marca, modelo, tipo_conexion, serial_externo, estacion_externa, capacidad_kwp, estado, id_api, observaciones, activo)`);
    nl(`SELECT g.id_proyecto, g.id_grupo, ${l(i.marca)}, ${l(i.modelo)}, ${l(i.conexion)}, ${l(i.serie)}, ${l(i.estacion)}, ${l(i.capacidadKwp)}, ${l(i.estado)}, ${idApi}, ${l(i.observaciones)}, 1`);
    nl(`  FROM grupos g JOIN proyectos p ON p.id_proyecto = g.id_proyecto`);
    nl(` WHERE p.nombre = ${l(i.proyecto)} AND g.nombre = ${l(i.grupo)}`);
    if (i.serie === null) {
      // Sin serie no hay llave unica: se evita duplicar al repetir la carga.
      nl(`   AND NOT EXISTS (SELECT 1 FROM inversores x WHERE x.id_grupo = g.id_grupo AND x.marca = ${l(i.marca)}`);
      nl(`                    AND x.modelo = ${l(i.modelo)} AND x.serial_externo IS NULL)`);
    }
    nl(`ON DUPLICATE KEY UPDATE id_grupo = VALUES(id_grupo), marca = VALUES(marca), modelo = VALUES(modelo),`);
    nl(`  tipo_conexion = VALUES(tipo_conexion), estacion_externa = COALESCE(VALUES(estacion_externa), estacion_externa),`);
    nl(`  capacidad_kwp = VALUES(capacidad_kwp), estado = VALUES(estado), id_api = COALESCE(VALUES(id_api), id_api),`);
    nl(`  observaciones = VALUES(observaciones);`);
  }
  nl();

  nl('COMMIT;');
  nl();
  nl('-- ------------------------------ VERIFICACION ------------------------------');
  nl('-- Ejecute estas consultas para comprobar el resultado:');
  nl(`-- SELECT (SELECT COUNT(*) FROM clientes) AS clientes, (SELECT COUNT(*) FROM proyectos) AS proyectos,`);
  nl(`--        (SELECT COUNT(*) FROM grupos) AS grupos, (SELECT COUNT(*) FROM inversores) AS inversores;`);
  nl(`-- SELECT i.serial_externo, i.id_api, g.nombre AS grupo, p.nombre AS proyecto FROM inversores i`);
  nl(`--   JOIN grupos g ON g.id_grupo = i.id_grupo JOIN proyectos p ON p.id_proyecto = i.id_proyecto WHERE i.tipo_conexion = 'HUAWEI_API';`);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function principal(): Promise<void> {
  const [comando, entrada, salidaArg] = process.argv.slice(2);

  if (comando === 'plantilla') {
    const destino = path.resolve(
      salidaArg ?? path.join(__dirname, '..', '..', '..', 'database', 'seeds', 'plantilla_carga_masiva.xlsx'),
    );
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, await generarPlantillaCargaMasiva());
    console.log(`Plantilla generada: ${destino}`);
    return;
  }

  if (comando === 'sql') {
    if (!entrada) {
      console.error('Indique el archivo Excel:  npm run db:carga-masiva -- ruta/al/archivo.xlsx [salida.sql]');
      process.exit(1);
    }
    const origen = path.resolve(entrada);
    if (!fs.existsSync(origen)) {
      console.error(`No se encontro el archivo: ${origen}`);
      process.exit(1);
    }
    const lectura = await leerCargaMasiva(fs.readFileSync(origen));

    for (const a of lectura.avisos) console.warn(`AVISO   [${a.hoja} fila ${a.fila}] ${a.mensaje}`);
    if (lectura.errores.length > 0) {
      for (const e of lectura.errores) console.error(`ERROR   [${e.hoja}${e.fila ? ` fila ${e.fila}` : ''}] ${e.mensaje}`);
      console.error(`\nSe encontraron ${lectura.errores.length} error(es). Corrija el Excel y vuelva a ejecutar: no se genero ningun SQL.`);
      process.exit(2);
    }

    const destino = path.resolve(salidaArg ?? origen.replace(/\.xlsx$/i, '') + '.sql');
    fs.writeFileSync(destino, generarSql(lectura.datos, path.basename(origen)), 'utf8');
    const d = lectura.datos;
    console.log(
      `\nListo: ${d.clientes.length} cliente(s), ${d.proyectos.length} proyecto(s), ${d.grupos.length} grupo(s), ${d.inversores.length} inversor(es).`,
    );
    console.log(`SQL generado: ${destino}`);
    return;
  }

  console.error('Uso:\n  npm run db:plantilla-carga\n  npm run db:carga-masiva -- archivo.xlsx [salida.sql]');
  process.exit(1);
}

if (require.main === module) {
  principal().catch((error) => {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
