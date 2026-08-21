/**
 * Errores de aplicacion con mensajes en espanol y codigo estable para el
 * frontend. El manejador centralizado los traduce a respuestas HTTP.
 */
export class AppError extends Error {
  readonly status: number;
  readonly codigo: string;
  readonly detalles?: unknown;

  constructor(status: number, codigo: string, mensaje: string, detalles?: unknown) {
    super(mensaje);
    this.name = 'AppError';
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

export const errores = {
  noAutenticado: (mensaje = 'Su sesion no es valida o expiro. Inicie sesion nuevamente.') =>
    new AppError(401, 'NO_AUTENTICADO', mensaje),

  sinPermiso: (permiso?: string) =>
    new AppError(
      403,
      'SIN_PERMISO',
      permiso
        ? `No cuenta con el permiso necesario para realizar esta accion (${permiso}).`
        : 'No cuenta con permisos para realizar esta accion.',
      permiso ? { permiso } : undefined,
    ),

  noEncontrado: (recurso: string) =>
    new AppError(404, 'NO_ENCONTRADO', `No se encontro ${recurso}.`),

  validacion: (mensaje: string, detalles?: unknown) =>
    new AppError(422, 'VALIDACION', mensaje, detalles),

  conflicto: (mensaje: string, detalles?: unknown) =>
    new AppError(409, 'CONFLICTO', mensaje, detalles),

  reglaNegocio: (mensaje: string, detalles?: unknown) =>
    new AppError(409, 'REGLA_NEGOCIO', mensaje, detalles),

  solicitudInvalida: (mensaje: string, detalles?: unknown) =>
    new AppError(400, 'SOLICITUD_INVALIDA', mensaje, detalles),

  demasiadasSolicitudes: (mensaje = 'Demasiadas solicitudes. Intente mas tarde.') =>
    new AppError(429, 'LIMITE_SOLICITUDES', mensaje),

  servicioNoDisponible: (mensaje: string, detalles?: unknown) =>
    new AppError(503, 'SERVICIO_NO_DISPONIBLE', mensaje, detalles),

  interno: (mensaje = 'Ocurrio un error inesperado. Contacte al administrador.') =>
    new AppError(500, 'ERROR_INTERNO', mensaje),
};
