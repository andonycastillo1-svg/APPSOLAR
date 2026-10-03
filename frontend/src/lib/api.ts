/**
 * Cliente HTTP del API.
 *
 * - Las credenciales viajan en cookies HttpOnly: el token de acceso nunca se
 *   guarda en `localStorage`.
 * - Toda peticion que modifica estado envia el token CSRF (double submit).
 * - Un 401 dispara UNA renovacion de sesion y reintenta la peticion.
 */

const BASE = import.meta.env.VITE_API_URL || '/api';

export interface RespuestaApi<T> {
  ok: true;
  datos: T;
  meta?: Record<string, unknown>;
}

export interface ErrorApiCuerpo {
  ok: false;
  error: {
    codigo: string;
    mensaje: string;
    detalles?: unknown;
    correlationId?: string;
  };
}

export class ErrorApi extends Error {
  readonly codigo: string;
  readonly estado: number;
  readonly detalles?: unknown;
  readonly correlationId?: string;

  constructor(estado: number, cuerpo: ErrorApiCuerpo['error']) {
    super(cuerpo.mensaje);
    this.name = 'ErrorApi';
    this.estado = estado;
    this.codigo = cuerpo.codigo;
    this.detalles = cuerpo.detalles;
    this.correlationId = cuerpo.correlationId;
  }

  /** Errores de validacion por campo, listos para mostrar junto al input. */
  get erroresPorCampo(): Record<string, string> {
    const salida: Record<string, string> = {};
    if (Array.isArray(this.detalles)) {
      for (const detalle of this.detalles as Array<{ campo?: string; mensaje?: string }>) {
        if (detalle?.campo && detalle?.mensaje) salida[detalle.campo] = detalle.mensaje;
      }
    }
    return salida;
  }
}

function leerCookie(nombre: string): string | null {
  const partes = document.cookie.split('; ');
  for (const parte of partes) {
    const [clave, ...resto] = parte.split('=');
    if (clave === nombre) return decodeURIComponent(resto.join('='));
  }
  return null;
}

export function tokenCsrf(): string {
  return leerCookie('as_csrf') ?? '';
}

let renovando: Promise<boolean> | null = null;

async function renovarSesion(): Promise<boolean> {
  if (!renovando) {
    renovando = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': tokenCsrf() },
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        setTimeout(() => {
          renovando = null;
        }, 0);
      });
  }
  return renovando;
}

export interface OpcionesPeticion {
  metodo?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  cuerpo?: unknown;
  parametros?: Record<string, string | number | boolean | null | undefined>;
  formData?: FormData;
  senal?: AbortSignal;
  sinReintento?: boolean;
}

export function construirUrl(
  ruta: string,
  parametros?: OpcionesPeticion['parametros'],
): string {
  const url = new URL(`${BASE}${ruta}`, window.location.origin);
  if (parametros) {
    for (const [clave, valor] of Object.entries(parametros)) {
      if (valor === undefined || valor === null || valor === '') continue;
      url.searchParams.set(clave, String(valor));
    }
  }
  return url.toString();
}

export async function peticion<T>(
  ruta: string,
  opciones: OpcionesPeticion = {},
): Promise<RespuestaApi<T>> {
  const metodo = opciones.metodo ?? 'GET';
  const cabeceras: Record<string, string> = {};

  if (metodo !== 'GET') cabeceras['x-csrf-token'] = tokenCsrf();
  if (opciones.cuerpo !== undefined) cabeceras['content-type'] = 'application/json';

  const respuesta = await fetch(construirUrl(ruta, opciones.parametros), {
    method: metodo,
    credentials: 'include',
    headers: cabeceras,
    body: opciones.formData ?? (opciones.cuerpo !== undefined ? JSON.stringify(opciones.cuerpo) : undefined),
    signal: opciones.senal,
  });

  if (respuesta.status === 401 && !opciones.sinReintento && !ruta.startsWith('/auth/')) {
    const renovado = await renovarSesion();
    if (renovado) {
      return peticion<T>(ruta, { ...opciones, sinReintento: true });
    }
  }

  const texto = await respuesta.text();
  let cuerpo: unknown = {};
  try {
    cuerpo = texto ? JSON.parse(texto) : {};
  } catch {
    throw new ErrorApi(respuesta.status, {
      codigo: 'RESPUESTA_INVALIDA',
      mensaje: 'El servidor devolvio una respuesta que no se pudo interpretar.',
    });
  }

  if (!respuesta.ok) {
    const error = (cuerpo as ErrorApiCuerpo).error ?? {
      codigo: 'ERROR_DESCONOCIDO',
      mensaje: 'Ocurrio un error inesperado al comunicarse con el servidor.',
    };
    throw new ErrorApi(respuesta.status, error);
  }

  return cuerpo as RespuestaApi<T>;
}

export const api = {
  obtener: <T>(ruta: string, parametros?: OpcionesPeticion['parametros']) =>
    peticion<T>(ruta, { metodo: 'GET', parametros }),
  crear: <T>(ruta: string, cuerpo?: unknown) => peticion<T>(ruta, { metodo: 'POST', cuerpo }),
  actualizar: <T>(ruta: string, cuerpo?: unknown) => peticion<T>(ruta, { metodo: 'PUT', cuerpo }),
  eliminar: <T>(ruta: string) => peticion<T>(ruta, { metodo: 'DELETE' }),
  subir: <T>(ruta: string, formData: FormData) => peticion<T>(ruta, { metodo: 'POST', formData }),
};

/** Descarga un archivo generado por el API respetando la sesion con cookies. */
export async function descargar(
  ruta: string,
  parametros?: OpcionesPeticion['parametros'],
  nombreSugerido?: string,
): Promise<void> {
  const respuesta = await fetch(construirUrl(ruta, parametros), { credentials: 'include' });

  if (!respuesta.ok) {
    let mensaje = 'No fue posible generar el archivo solicitado.';
    try {
      const cuerpo = (await respuesta.json()) as ErrorApiCuerpo;
      mensaje = cuerpo.error?.mensaje ?? mensaje;
    } catch {
      /* se conserva el mensaje generico */
    }
    throw new ErrorApi(respuesta.status, { codigo: 'DESCARGA_FALLIDA', mensaje });
  }

  const cabecera = respuesta.headers.get('content-disposition') ?? '';
  const coincidencia = cabecera.match(/filename="?([^";]+)"?/i);
  const nombre = nombreSugerido ?? coincidencia?.[1] ?? 'descarga';

  const blob = await respuesta.blob();
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Abre un PDF del API en una pestaña nueva para visualizarlo o imprimirlo. */
export async function abrirEnPestana(
  ruta: string,
  parametros?: OpcionesPeticion['parametros'],
): Promise<void> {
  const respuesta = await fetch(construirUrl(ruta, parametros), { credentials: 'include' });
  if (!respuesta.ok) {
    throw new ErrorApi(respuesta.status, {
      codigo: 'DESCARGA_FALLIDA',
      mensaje: 'No fue posible generar el documento.',
    });
  }
  const blob = await respuesta.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
