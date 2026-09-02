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

/** Grupo de inversores tal como lo devuelve el catalogo del proyecto. */
export interface GrupoResumen {
  id_grupo: number;
  nombre: string;
  cantidad_inversores_declarada: number | null;
  inversores_registrados: number;
  inversoresFaltantes: number;
  avisoInversores: string | null;
  tiene_banco_baterias: number;
  capacidad_baterias_kwh: number | null;
  capacidad_kwp: number | null;
  activo: number;
}

/**
 * Grupos de un proyecto (jerarquia PROYECTO -> GRUPO -> INVERSOR).
 *
 * Se consulta solo cuando hay un proyecto seleccionado, porque los grupos
 * pertenecen siempre a un proyecto concreto.
 */
export function useGrupos(idProyecto: number | string | null | undefined) {
  const { puede } = useSesion();
  const id = Number(idProyecto);
  const habilitado = puede('proyectos.ver') && Number.isInteger(id) && id > 0;

  const consulta = useQuery({
    queryKey: ['catalogo', 'grupos', id],
    enabled: habilitado,
    staleTime: 60_000,
    queryFn: async () => (await api.obtener<GrupoResumen[]>(`/projects/${id}/groups`)).datos,
  });

  return {
    grupos: consulta.data ?? [],
    cargando: consulta.isLoading,
    habilitado,
  };
}
