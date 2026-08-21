import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface MetaPaginacion {
  pagina: number;
  porPagina: number;
  total: number;
  totalPaginas: number;
}

export interface EstadoListado {
  pagina: number;
  porPagina: number;
  buscar: string;
  orden?: string;
  direccion: 'asc' | 'desc';
  [clave: string]: string | number | undefined;
}

/**
 * Hook comun de los listados: busqueda, filtros, ordenamiento y paginacion
 * resueltos en el servidor (nunca en memoria del navegador).
 */
export function useListado<T>(
  clave: string,
  ruta: string,
  inicial: Partial<EstadoListado> = {},
  habilitado = true,
) {
  const [estado, setEstado] = useState<EstadoListado>({
    pagina: 1,
    porPagina: 20,
    buscar: '',
    direccion: 'asc',
    ...inicial,
  });

  const consulta = useQuery({
    queryKey: [clave, estado],
    enabled: habilitado,
    queryFn: async () => {
      const parametros: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(estado)) {
        if (v === undefined || v === '') continue;
        parametros[k] = v as string | number;
      }
      const respuesta = await api.obtener<T[]>(ruta, parametros);
      return {
        filas: respuesta.datos,
        meta: (respuesta.meta ?? {
          pagina: 1,
          porPagina: estado.porPagina,
          total: respuesta.datos.length,
          totalPaginas: 1,
        }) as unknown as MetaPaginacion,
      };
    },
  });

  const actualizar = (cambios: Partial<EstadoListado>) => {
    setEstado((actual) => ({
      ...actual,
      ...cambios,
      // Cualquier cambio de filtro devuelve el listado a la primera pagina.
      pagina: cambios.pagina ?? 1,
    }));
  };

  const ordenar = (campo: string, direccion: 'asc' | 'desc') =>
    actualizar({ orden: campo, direccion });

  return {
    estado,
    actualizar,
    ordenar,
    irAPagina: (pagina: number) => setEstado((actual) => ({ ...actual, pagina })),
    filas: consulta.data?.filas,
    meta: consulta.data?.meta,
    cargando: consulta.isLoading,
    error: consulta.error,
    recargar: () => void consulta.refetch(),
    consulta,
  };
}
