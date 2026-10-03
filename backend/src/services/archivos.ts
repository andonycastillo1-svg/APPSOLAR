import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env';
import { errores } from '../utils/errors';

/**
 * Manejo seguro de archivos de importacion.
 *
 * Principios:
 *  - Nunca se confia en el nombre ni en el MIME declarado por el navegador.
 *  - Se valida extension, tamaño y firma binaria real del contenido.
 *  - El archivo se guarda con un nombre generado por el servidor (sin ruta ni
 *    caracteres del nombre original), fuera del arbol servido publicamente.
 */

export const almacenamientoMemoria = multer.memoryStorage();

export function crearSubidor() {
  return multer({
    storage: almacenamientoMemoria,
    limits: {
      fileSize: env.uploads.maxMb * 1024 * 1024,
      files: 1,
      fields: 30,
    },
    fileFilter: (_req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!env.uploads.allowedExt.includes(extension)) {
        cb(
          errores.validacion(
            `Solo se aceptan archivos ${env.uploads.allowedExt.join(' o ')}. Recibido: "${extension || 'sin extension'}".`,
          ),
        );
        return;
      }
      cb(null, true);
    },
  });
}

export interface ArchivoValidado {
  rutaAbsoluta: string;
  nombreOriginal: string;
  nombreSeguro: string;
  extension: '.csv' | '.xlsx';
  tamanoBytes: number;
  hash: string;
  contenido: Buffer;
}

/** Firma binaria de un ZIP (todo XLSX es un contenedor OOXML/ZIP). */
function esZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/** Detecta contenido peligroso disfrazado de archivo de datos. */
function contienePeligro(buffer: Buffer, extension: string): string | null {
  if (extension === '.xlsx') {
    if (!esZip(buffer)) {
      return 'El archivo no es un XLSX valido (su contenido no corresponde al formato).';
    }
    const texto = buffer.toString('latin1');
    // Los libros con macros (.xlsm) contienen vbaProject.bin: se rechazan.
    if (texto.includes('vbaProject.bin')) {
      return 'El archivo contiene macros (VBA). Por seguridad no se aceptan libros con macros.';
    }
    if (texto.includes('xl/externalLinks/')) {
      return 'El archivo contiene vinculos externos. Guarde una copia con valores y vuelva a intentarlo.';
    }
    return null;
  }

  // CSV: se diagnostica primero el caso mas especifico (archivo comprimido
  // renombrado) y despues cualquier otro contenido binario.
  if (esZip(buffer)) {
    return 'El archivo tiene extension .csv pero su contenido es un archivo comprimido.';
  }
  if (buffer.includes(0)) return 'El archivo CSV contiene datos binarios y fue rechazado.';
  return null;
}

/**
 * Neutraliza la inyeccion de formulas en CSV (CSV injection).
 * Se aplica al LEER, de modo que un valor como `=cmd|...` nunca se interprete
 * ni se reexporte como formula.
 */
export function neutralizarFormula(valor: string): string {
  if (/^[=+\-@\t\r]/.test(valor)) return `'${valor}`;
  return valor;
}

export function detectarFormula(valor: unknown): boolean {
  return typeof valor === 'string' && /^[=+@]/.test(valor.trim());
}

export function asegurarDirectorio(): string {
  if (!fs.existsSync(env.uploads.dir)) {
    fs.mkdirSync(env.uploads.dir, { recursive: true });
  }
  return env.uploads.dir;
}

/** Valida el archivo recibido y lo persiste con un nombre seguro. */
export function validarYGuardar(archivo: Express.Multer.File): ArchivoValidado {
  const extension = path.extname(archivo.originalname).toLowerCase();
  if (!env.uploads.allowedExt.includes(extension)) {
    throw errores.validacion(`Extension no permitida: ${extension}`);
  }

  if (archivo.size === 0) throw errores.validacion('El archivo esta vacio.');
  if (archivo.size > env.uploads.maxMb * 1024 * 1024) {
    throw errores.validacion(`El archivo supera el maximo permitido de ${env.uploads.maxMb} MB.`);
  }

  const peligro = contienePeligro(archivo.buffer, extension);
  if (peligro) throw errores.validacion(peligro);

  const hash = crypto.createHash('sha256').update(archivo.buffer).digest('hex');
  const nombreSeguro = `${Date.now()}_${hash.slice(0, 16)}${extension}`;
  const directorio = asegurarDirectorio();
  const rutaAbsoluta = path.join(directorio, nombreSeguro);

  // Defensa contra path traversal: la ruta final debe quedar dentro del directorio.
  if (!path.resolve(rutaAbsoluta).startsWith(path.resolve(directorio) + path.sep)) {
    throw errores.solicitudInvalida('Ruta de archivo invalida.');
  }

  fs.writeFileSync(rutaAbsoluta, archivo.buffer, { mode: 0o600 });

  return {
    rutaAbsoluta,
    nombreOriginal: path.basename(archivo.originalname).slice(0, 255),
    nombreSeguro,
    extension: extension as '.csv' | '.xlsx',
    tamanoBytes: archivo.size,
    hash,
    contenido: archivo.buffer,
  };
}

/** Guarda el resultado normalizado de la previsualizacion para su confirmacion. */
export function guardarLotePreparado(idHistorico: number, datos: unknown): string {
  const directorio = asegurarDirectorio();
  const ruta = path.join(directorio, `lote_${idHistorico}.json`);
  fs.writeFileSync(ruta, JSON.stringify(datos), { mode: 0o600 });
  return ruta;
}

export function leerLotePreparado<T>(idHistorico: number): T | null {
  const ruta = path.join(asegurarDirectorio(), `lote_${idHistorico}.json`);
  if (!fs.existsSync(ruta)) return null;
  return JSON.parse(fs.readFileSync(ruta, 'utf8')) as T;
}

export function eliminarLotePreparado(idHistorico: number): void {
  const ruta = path.join(asegurarDirectorio(), `lote_${idHistorico}.json`);
  if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
}
