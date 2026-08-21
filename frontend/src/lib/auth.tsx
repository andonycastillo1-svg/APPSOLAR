import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ErrorApi } from './api';

export type RolCodigo = 'ADMINISTRATIVO' | 'OPERATIVO' | 'GERENCIAL';

export interface Usuario {
  id_usuario: number;
  nombre: string;
  email: string;
  rol: RolCodigo;
  id_rol: number;
  permisos: string[];
}

interface EstadoSesion {
  usuario: Usuario | null;
  cargando: boolean;
  debeCambiarPassword: boolean;
  ultimoAcceso: string | null;
}

interface ContextoSesion extends EstadoSesion {
  iniciarSesion: (email: string, password: string) => Promise<void>;
  cerrarSesion: () => Promise<void>;
  refrescarPerfil: () => Promise<void>;
  puede: (...permisos: string[]) => boolean;
  puedeAlguno: (...permisos: string[]) => boolean;
}

const Contexto = createContext<ContextoSesion | null>(null);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoSesion>({
    usuario: null,
    cargando: true,
    debeCambiarPassword: false,
    ultimoAcceso: null,
  });

  const cargarPerfil = useCallback(async () => {
    try {
      const respuesta = await api.obtener<{
        usuario: Usuario;
        debeCambiarPassword: boolean;
        ultimoAcceso: string | null;
      }>('/auth/me');
      setEstado({
        usuario: respuesta.datos.usuario,
        cargando: false,
        debeCambiarPassword: respuesta.datos.debeCambiarPassword,
        ultimoAcceso: respuesta.datos.ultimoAcceso,
      });
    } catch {
      setEstado({ usuario: null, cargando: false, debeCambiarPassword: false, ultimoAcceso: null });
    }
  }, []);

  useEffect(() => {
    void cargarPerfil();
  }, [cargarPerfil]);

  const iniciarSesion = useCallback(async (email: string, password: string) => {
    const respuesta = await api.crear<{
      usuario: Usuario;
      debeCambiarPassword: boolean;
    }>('/auth/login', { email, password });
    setEstado({
      usuario: respuesta.datos.usuario,
      cargando: false,
      debeCambiarPassword: respuesta.datos.debeCambiarPassword,
      ultimoAcceso: null,
    });
  }, []);

  const cerrarSesion = useCallback(async () => {
    try {
      await api.crear('/auth/logout');
    } catch (error) {
      // Una sesion ya invalida no impide limpiar el estado local.
      if (!(error instanceof ErrorApi)) throw error;
    }
    setEstado({ usuario: null, cargando: false, debeCambiarPassword: false, ultimoAcceso: null });
  }, []);

  const valor = useMemo<ContextoSesion>(
    () => ({
      ...estado,
      iniciarSesion,
      cerrarSesion,
      refrescarPerfil: cargarPerfil,
      // Ocultar una opcion en la interfaz NO sustituye la autorizacion del
      // servidor: estas comprobaciones solo mejoran la experiencia de uso.
      puede: (...permisos: string[]) =>
        permisos.every((p) => estado.usuario?.permisos.includes(p) ?? false),
      puedeAlguno: (...permisos: string[]) =>
        permisos.some((p) => estado.usuario?.permisos.includes(p) ?? false),
    }),
    [estado, iniciarSesion, cerrarSesion, cargarPerfil],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSesion(): ContextoSesion {
  const contexto = useContext(Contexto);
  if (!contexto) throw new Error('useSesion debe usarse dentro de ProveedorSesion.');
  return contexto;
}

export const NOMBRE_ROL: Record<RolCodigo, string> = {
  ADMINISTRATIVO: 'Administrativo',
  OPERATIVO: 'Operativo',
  GERENCIAL: 'Gerencial',
};
