import type { Permiso, RolCodigo } from '../config/permisos';

export interface UsuarioAutenticado {
  id_usuario: number;
  nombre: string;
  email: string;
  rol: RolCodigo;
  id_rol: number;
  permisos: Permiso[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioAutenticado;
      correlationId: string;
      /** Ruta absoluta del archivo cargado, validado por el middleware de subida. */
      archivoSeguro?: {
        rutaAbsoluta: string;
        nombreOriginal: string;
        nombreSeguro: string;
        extension: string;
        tamanoBytes: number;
        hash: string;
      };
    }
  }
}

export {};
