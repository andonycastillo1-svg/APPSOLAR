import { useSyncExternalStore } from 'react';

/**
 * Tema visual (claro / oscuro).
 *
 * Por omision sigue la preferencia del sistema operativo; la eleccion manual
 * se recuerda en el navegador. El almacenamiento puede no estar disponible
 * (modo privado, bloqueado), por eso todo acceso va protegido.
 */

export type Tema = 'claro' | 'oscuro';

const CLAVE = 'retse.tema';
const oyentes = new Set<() => void>();

function leerGuardado(): Tema | null {
  try {
    const valor = window.localStorage.getItem(CLAVE);
    return valor === 'claro' || valor === 'oscuro' ? valor : null;
  } catch {
    return null;
  }
}

function preferenciaSistema(): Tema {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro';
  } catch {
    return 'claro';
  }
}

let actual: Tema = 'claro';

function aplicar(tema: Tema): void {
  actual = tema;
  document.documentElement.setAttribute('data-tema', tema);
  oyentes.forEach((avisar) => avisar());
}

/** Se llama una sola vez al arrancar, antes de pintar la aplicacion. */
export function iniciarTema(): void {
  aplicar(leerGuardado() ?? preferenciaSistema());
}

export function cambiarTema(tema?: Tema): void {
  const siguiente = tema ?? (actual === 'oscuro' ? 'claro' : 'oscuro');
  try {
    window.localStorage.setItem(CLAVE, siguiente);
  } catch {
    /* sin almacenamiento: el cambio vale solo para esta sesion */
  }
  aplicar(siguiente);
}

export function useTema(): Tema {
  return useSyncExternalStore(
    (avisar) => {
      oyentes.add(avisar);
      return () => oyentes.delete(avisar);
    },
    () => actual,
    () => 'claro' as Tema,
  );
}

/** Paletas de las graficas por tema (SVG no hereda bien las variables CSS). */
export const PALETAS: Record<Tema, { serie: string[]; rejilla: string; texto: string; fondo: string }> = {
  claro: {
    serie: ['#0b6bcb', '#16a34a', '#f59e0b', '#7c3aed', '#e11d48', '#0891b2', '#ea580c', '#475569'],
    rejilla: '#e3e9ed',
    texto: '#3d4a52',
    fondo: '#ffffff',
  },
  oscuro: {
    serie: ['#4da3ff', '#4ade80', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#fb923c', '#94a3b8'],
    rejilla: '#2a3b49',
    texto: '#b8c7d3',
    fondo: '#101c26',
  },
};
