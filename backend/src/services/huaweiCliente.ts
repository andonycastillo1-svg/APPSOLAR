import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

/**
 * Cliente del servicio Python interno (adaptador Huawei SmartPVMS).
 *
 * El servicio Python NUNCA se expone a Internet: Node.js es el unico punto
 * publico. La autenticacion entre ambos usa un token interno de servicio.
 */

export interface RegistroCanonico {
  serial: string;
  fecha: string;
  kwh: number;
  granularidad: 'DIARIA' | 'MENSUAL';
  estacion?: string | null;
}

export interface RespuestaSincronizacion {
  ok: boolean;
  modo: 'MOCK' | 'REAL';
  registros: RegistroCanonico[];
  advertencias: string[];
  /** serial (minusculas) -> codigo de estacion descubierto en el fabricante. */
  estaciones_resueltas?: Record<string, string>;
  duracion_ms: number;
  rango: { desde: string; hasta: string };
}

export interface RespuestaPrueba {
  ok: boolean;
  modo: 'MOCK' | 'REAL';
  mensaje: string;
  ip_saliente?: string | null;
  detalle?: Record<string, unknown>;
}

/** Traduce los codigos del adaptador a mensajes diferenciados en espanol. */
const MENSAJES: Record<string, { status: number; mensaje: string }> = {
  CREDENCIALES_INVALIDAS: {
    status: 401,
    mensaje:
      'Las credenciales configuradas para Huawei SmartPVMS no son validas. Verifiquelas con el administrador de la cuenta del fabricante.',
  },
  IP_NO_AUTORIZADA: {
    status: 403,
    mensaje:
      'La IP publica del servidor no esta autorizada por Huawei. Solicite el registro de la IP antes de activar el adaptador real.',
  },
  LIMITE_API: {
    status: 429,
    mensaje:
      'Se alcanzo el limite de consultas de la API de Huawei. Reintente mas tarde o reduzca la ventana de sincronizacion.',
  },
  TIEMPO_AGOTADO: {
    status: 504,
    mensaje: 'La consulta a Huawei SmartPVMS excedio el tiempo de espera. Intente nuevamente.',
  },
  FORMATO_INESPERADO: {
    status: 502,
    mensaje:
      'Huawei SmartPVMS devolvio una respuesta con un formato inesperado. Revise la version del API configurada.',
  },
  SERVICIO_NO_DISPONIBLE: {
    status: 503,
    mensaje: 'El servicio de integracion no esta disponible en este momento.',
  },
  CONFIGURACION_INCOMPLETA: {
    status: 422,
    mensaje:
      'La configuracion de la integracion esta incompleta. Complete credenciales y endpoint antes de sincronizar.',
  },
};

function traducir(codigo: string | undefined, detalle?: unknown): AppError {
  const conocido = codigo ? MENSAJES[codigo] : undefined;
  if (conocido) return new AppError(conocido.status, codigo!, conocido.mensaje, detalle);
  return new AppError(
    502,
    codigo ?? 'ERROR_INTEGRACION',
    'Ocurrio un error al comunicarse con el servicio de integracion Huawei.',
    detalle,
  );
}

async function llamar<T>(ruta: string, cuerpo: unknown, timeoutMs: number): Promise<T> {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), timeoutMs);

  try {
    const respuesta = await fetch(`${env.python.url}${ruta}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': env.python.token,
      },
      body: JSON.stringify(cuerpo),
      signal: control.signal,
    });

    const texto = await respuesta.text();
    let datos: unknown;
    try {
      datos = texto ? JSON.parse(texto) : {};
    } catch {
      throw traducir('FORMATO_INESPERADO', { cuerpo: texto.slice(0, 200) });
    }

    if (!respuesta.ok) {
      const error = datos as { codigo?: string; detalle?: unknown; mensaje?: string };
      throw traducir(error.codigo, error.detalle ?? error.mensaje);
    }

    return datos as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === 'AbortError') throw traducir('TIEMPO_AGOTADO');
    logger.error({ err: error }, 'Fallo la comunicacion con el servicio Python');
    throw traducir('SERVICIO_NO_DISPONIBLE', { mensaje: (error as Error).message });
  } finally {
    clearTimeout(temporizador);
  }
}

export interface ConfiguracionAdaptador {
  modo: 'MOCK' | 'REAL';
  endpoint: string;
  ip_autorizada?: string | null;
  usuario_api?: string | null;
  timeout_s: number;
  max_reintentos: number;
}

export async function probarConexion(config: ConfiguracionAdaptador): Promise<RespuestaPrueba> {
  return llamar<RespuestaPrueba>('/huawei/test', { config }, env.python.timeoutMs);
}

export async function obtenerProduccion(
  config: ConfiguracionAdaptador,
  parametros: {
    seriales: string[];
    estaciones?: string[];
    desde: string;
    hasta: string;
    granularidad: 'DIARIA' | 'MENSUAL';
  },
): Promise<RespuestaSincronizacion> {
  return llamar<RespuestaSincronizacion>(
    '/huawei/production',
    { config, ...parametros },
    env.python.timeoutMs,
  );
}

export async function saludServicio(): Promise<{ ok: boolean; version?: string; modo?: string }> {
  try {
    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), 4000);
    const respuesta = await fetch(`${env.python.url}/health`, {
      headers: { 'x-service-token': env.python.token },
      signal: control.signal,
    });
    clearTimeout(temporizador);
    if (!respuesta.ok) return { ok: false };
    return (await respuesta.json()) as { ok: boolean; version?: string; modo?: string };
  } catch {
    return { ok: false };
  }
}
