import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';

/** Contrato de respuesta uniforme para todo el API. */
export interface RespuestaOk<T> {
  ok: true;
  datos: T;
  meta?: Record<string, unknown>;
}

export function ok<T>(res: Response, datos: T, meta?: Record<string, unknown>, status = 200): void {
  res.status(status).json({ ok: true, datos, ...(meta ? { meta } : {}) } satisfies RespuestaOk<T>);
}

export function creado<T>(res: Response, datos: T, meta?: Record<string, unknown>): void {
  ok(res, datos, meta, 201);
}

/** Envuelve manejadores asincronos para propagar errores al middleware central. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Paginacion y ordenamiento
// ---------------------------------------------------------------------------

export const esquemaPaginacion = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  porPagina: z.coerce.number().int().min(1).max(200).default(20),
  orden: z.string().max(40).optional(),
  direccion: z.enum(['asc', 'desc']).default('asc'),
  buscar: z.string().max(120).optional(),
});

export type Paginacion = z.infer<typeof esquemaPaginacion>;

export function limitesPaginacion(p: Paginacion) {
  return { limite: p.porPagina, desplazamiento: (p.pagina - 1) * p.porPagina };
}

export function metaPaginacion(p: Paginacion, total: number) {
  return {
    pagina: p.pagina,
    porPagina: p.porPagina,
    total,
    totalPaginas: Math.max(1, Math.ceil(total / p.porPagina)),
  };
}

/**
 * Convierte un campo de ordenamiento solicitado por el cliente en una columna
 * segura. Nunca se interpola texto libre en el SQL.
 */
export function columnaOrden(
  solicitado: string | undefined,
  permitidas: Record<string, string>,
  porDefecto: string,
): string {
  if (!solicitado) return porDefecto;
  return permitidas[solicitado] ?? porDefecto;
}

// ---------------------------------------------------------------------------
// Validacion declarativa
// ---------------------------------------------------------------------------

export function validarCuerpo<T extends ZodTypeAny>(esquema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const resultado = esquema.safeParse(req.body);
    if (!resultado.success) return next(resultado.error);
    req.body = resultado.data;
    next();
  };
}

export function validarConsulta<T extends ZodTypeAny>(esquema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const resultado = esquema.safeParse(req.query);
    if (!resultado.success) return next(resultado.error);
    // `req.query` es de solo lectura en Express 5; se guarda en un campo propio.
    (req as unknown as { consulta: unknown }).consulta = resultado.data;
    next();
  };
}

export function consulta<T>(req: Request): T {
  return (req as unknown as { consulta: T }).consulta;
}

/** Identificador numerico de ruta validado. */
export function idRuta(req: Request, nombre = 'id'): number {
  const valor = Number(req.params[nombre]);
  if (!Number.isInteger(valor) || valor <= 0) {
    throw Object.assign(new Error('Identificador invalido'), { status: 400 });
  }
  return valor;
}
