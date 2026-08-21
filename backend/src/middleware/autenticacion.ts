import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { errores } from '../utils/errors';
import {
  COOKIE_ACCESO,
  COOKIE_CSRF,
  buscarUsuarioPorId,
  construirUsuarioAutenticado,
  verificarTokenAcceso,
} from '../services/auth';
import type { Permiso } from '../config/permisos';

/** Asigna un identificador de correlacion a cada peticion. */
export function correlacion(req: Request, res: Response, next: NextFunction): void {
  const entrante = req.get('x-correlation-id');
  req.correlationId =
    entrante && /^[A-Za-z0-9-]{6,64}$/.test(entrante) ? entrante : crypto.randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}

function leerToken(req: Request): string | null {
  const cookie = req.cookies?.[COOKIE_ACCESO];
  if (cookie) return cookie;
  // Alternativa para clientes no navegador (pruebas automatizadas, cron interno).
  const cabecera = req.get('authorization');
  if (cabecera?.startsWith('Bearer ')) return cabecera.slice(7);
  return null;
}

/** Caso de uso transversal "Autenticar usuario". */
export async function requiereAutenticacion(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = leerToken(req);
    if (!token) throw errores.noAutenticado('Debe iniciar sesion para continuar.');

    const payload = verificarTokenAcceso(token);
    const registro = await buscarUsuarioPorId(payload.sub);

    if (!registro) throw errores.noAutenticado();
    if (!registro.activo) {
      throw errores.noAutenticado('Su usuario fue desactivado. Contacte al administrador.');
    }

    req.usuario = await construirUsuarioAutenticado(registro);
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Proteccion CSRF (double submit cookie) para metodos que modifican estado.
 * Solo aplica cuando la sesion viaja por cookie; las peticiones autenticadas
 * con cabecera Authorization no son vulnerables a CSRF.
 */
export function protegerCsrf(req: Request, _res: Response, next: NextFunction): void {
  const metodosSeguros = ['GET', 'HEAD', 'OPTIONS'];
  if (metodosSeguros.includes(req.method)) return next();
  if (!req.cookies?.[COOKIE_ACCESO]) return next();

  const cookie = req.cookies?.[COOKIE_CSRF];
  const cabecera = req.get('x-csrf-token');

  if (!cookie || !cabecera || cookie.length !== cabecera.length) {
    return next(
      errores.solicitudInvalida(
        'La solicitud no incluye un token de seguridad valido. Recargue la pagina e intente de nuevo.',
      ),
    );
  }
  if (!crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(cabecera))) {
    return next(
      errores.solicitudInvalida(
        'La solicitud no incluye un token de seguridad valido. Recargue la pagina e intente de nuevo.',
      ),
    );
  }
  next();
}

/** Exige uno o varios permisos (todos deben cumplirse). */
export function requierePermiso(...permisos: Permiso[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.usuario) return next(errores.noAutenticado());
    const faltante = permisos.find((p) => !req.usuario!.permisos.includes(p));
    if (faltante) return next(errores.sinPermiso(faltante));
    next();
  };
}

/** Exige al menos uno de los permisos indicados. */
export function requiereAlgunPermiso(...permisos: Permiso[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.usuario) return next(errores.noAutenticado());
    const tiene = permisos.some((p) => req.usuario!.permisos.includes(p));
    if (!tiene) return next(errores.sinPermiso(permisos[0]));
    next();
  };
}

export function tienePermiso(req: Request, permiso: Permiso): boolean {
  return Boolean(req.usuario?.permisos.includes(permiso));
}
