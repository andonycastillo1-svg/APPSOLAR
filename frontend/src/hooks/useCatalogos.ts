import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSesion } from '../lib/auth';

export interface ClienteResumen {
  id_cliente: number;
  nombre: string;
  nit: string;
  activo: number;
}

export interface ProyectoResumen {
  id_proyecto: number;
  id_cliente: number;
  nombre: string;
  tipo_proyecto: string;
  capacidad_kwp: number | null;
  activo: number;
  cliente?: string;
}

export interface InversorResumen {
  id_inversor: number;
  id_proyecto: number;
  marca: string;
  modelo: string;
  serial_externo: string | null;
  tipo_conexion: string;
  capacidad_kwp: number | null;
  proyecto?: string;
  activo: number;
}

/** Catalogos usados por los filtros globales de todas las pantallas. */
export function useCatalogos() {
  const { puede } = useSesion();

  const clientes = useQuery({
    queryKey: ['catalogo', 'clientes'],
    enabled: puede('clientes.ver'),
    staleTime: 120_000,
    queryFn: async () =>
      (await api.obtener<ClienteResumen[]>('/clients', { porPagina: 200, activo: '1' })).datos,
  });

  const proyectos = useQuery({
    queryKey: ['catalogo', 'proyectos'],
    enabled: puede('proyectos.ver'),
    staleTime: 120_000,
    queryFn: async () =>
      (await api.obtener<ProyectoResumen[]>('/projects', { porPagina: 200 })).datos,
  });

  const inversores = useQuery({
    queryKey: ['catalogo', 'inversores'],
    enabled: puede('inversores.ver'),
    staleTime: 120_000,
    queryFn: async () =>
      (await api.obtener<InversorResumen[]>('/inverters', { porPagina: 200 })).datos,
  });

  return {
    clientes: clientes.data ?? [],
    proyectos: proyectos.data ?? [],
    inversores: inversores.data ?? [],
    cargando: clientes.isLoading || proyectos.isLoading || inversores.isLoading,
  };
}
