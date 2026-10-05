import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../config/logger';
import { env } from '../config/env';

export interface RespuestaError {
  ok: false;
  error: {
    codigo: string;
    mensaje: string;
    detalles?: unknown;
    correlationId?: string;
  };
}

/** Traduce los errores de Zod a mensajes en español por campo. */
function detallesZod(error: ZodError) {
  return error.errors.map((e) => ({
    campo: e.path.join('.') || '(cuerpo)',
    mensaje: e.message,
  }));
}

export function noEncontrado(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: {
      codigo: 'RUTA_NO_ENCONTRADA',
      mensaje: `La ruta solicitada no existe: ${req.method} ${req.originalUrl}`,
      correlationId: req.correlationId,
    },
  } satisfies RespuestaError);
}

/** Manejo centralizado de errores: nunca filtra detalles internos al cliente. */
export function manejadorErrores(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(422).json({
      ok: false,
      error: {
        codigo: 'VALIDACION',
        mensaje: 'Algunos datos enviados no son validos. Revise los campos marcados.',
        detalles: detallesZod(err),
        correlationId: req.correlationId,
      },
    } satisfies RespuestaError);
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, correlationId: req.correlationId }, err.message);
    } else {
      logger.warn(
        { codigo: err.codigo, correlationId: req.correlationId, ruta: req.originalUrl },
        err.message,
      );
    }
    res.status(err.status).json({
      ok: false,
      error: {
        codigo: err.codigo,
        mensaje: err.message,
        detalles: err.detalles,
        correlationId: req.correlationId,
      },
    } satisfies RespuestaError);
    return;
  }

  // Errores de MySQL traducidos a lenguaje de negocio.
  const codigoMysql = (err as { code?: string })?.code;
  if (codigoMysql === 'ER_DUP_ENTRY') {
    res.status(409).json({
      ok: false,
      error: {
        codigo: 'CONFLICTO',
        mensaje: 'Ya existe un registro con esos datos unicos.',
        correlationId: req.correlationId,
      },
    } satisfies RespuestaError);
    return;
  }
  if (codigoMysql === 'ER_ROW_IS_REFERENCED_2') {
    res.status(409).json({
      ok: false,
      error: {
        codigo: 'REGLA_NEGOCIO',
        mensaje:
          'No se puede eliminar porque existen registros relacionados. Utilice la desactivacion.',
        correlationId: req.correlationId,
      },
    } satisfies RespuestaError);
    return;
  }
  if (codigoMysql === 'ER_NO_REFERENCED_ROW_2') {
    res.status(422).json({
      ok: false,
      error: {
        codigo: 'VALIDACION',
        mensaje: 'Alguna referencia enviada no existe (cliente, proyecto o inversor).',
        correlationId: req.correlationId,
      },
    } satisfies RespuestaError);
    return;
  }

  // El motivo va en el texto del registro (no se muestra al usuario) para poder
  // diagnosticar desde el panel del hosting, que solo exhibe el mensaje.
  const motivoInterno = err instanceof Error ? err.message : String(err);
  logger.error(
    { err, correlationId: req.correlationId, ruta: req.originalUrl },
    `Error no controlado [${req.correlationId}] ${req.method} ${req.originalUrl}: ${motivoInterno}`,
  );

  // Solo quien administra la configuracion ve el motivo tecnico; el resto, el mensaje generico.
  const esAdministrador = Boolean(req.usuario?.permisos.includes('config.gestionar'));
  const sufijoTecnico = esAdministrador ? ` Detalle tecnico: ${motivoInterno.slice(0, 300)}` : '';

  res.status(500).json({
    ok: false,
    error: {
      codigo: 'ERROR_INTERNO',
      mensaje: `Ocurrio un error inesperado. Si persiste, informe al administrador.${sufijoTecnico}`,
      detalles: env.isProduction ? undefined : { mensajeTecnico: String(err) },
      correlationId: req.correlationId,
    },
  } satisfies RespuestaError);
}
