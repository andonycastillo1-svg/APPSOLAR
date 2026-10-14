import type { ReactNode } from 'react';

/**
 * Iconos del sistema (SVG en linea, sin librerias).
 *
 * Cada icono se anima con CSS al pasar el cursor, al enfocarse o, en el caso
 * de los que lo indican, de forma continua mientras `activo` es verdadero
 * (por ejemplo, el de sincronizar mientras trabaja). Las animaciones se
 * apagan con "reducir movimiento".
 */

export type NombreIcono =
  | 'tablero'
  | 'resumen'
  | 'reportes'
  | 'produccion'
  | 'importar'
  | 'sincronizar'
  | 'clientes'
  | 'proyectos'
  | 'inversores'
  | 'usuarios'
  | 'auditoria'
  | 'configuracion'
  | 'estado'
  | 'menu'
  | 'sol'
  | 'luna'
  | 'perfil'
  | 'salir'
  | 'buscar'
  | 'mas'
  | 'imprimir'
  | 'descargar'
  | 'alerta'
  | 'ok'
  | 'cerrar'
  | 'editar'
  | 'flecha';

const TRAZOS: Record<NombreIcono, ReactNode> = {
  tablero: (
    <>
      <rect className="i-p1" x="3" y="3" width="7" height="9" rx="1.5" />
      <rect className="i-p2" x="14" y="3" width="7" height="5" rx="1.5" />
      <rect className="i-p3" x="14" y="12" width="7" height="9" rx="1.5" />
      <rect className="i-p4" x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  resumen: (
    <>
      <path d="M4 20V10" className="i-b1" />
      <path d="M10 20V4" className="i-b2" />
      <path d="M16 20v-7" className="i-b3" />
      <path d="M22 20H2" />
    </>
  ),
  reportes: (
    <>
      <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
      <path className="i-linea" d="M8 13h8M8 17h6" />
    </>
  ),
  produccion: <path className="i-rayo" d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  importar: (
    <>
      <path d="M12 16V4" className="i-subir" />
      <path d="m7 9 5-5 5 5" className="i-subir" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  sincronizar: (
    <g className="i-girar">
      <path d="M20 11a8 8 0 0 0-14.5-4.2M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.5 4.2M20 20v-4h-4" />
    </g>
  ),
  clientes: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path className="i-linea" d="M16 5a3.5 3.5 0 0 1 0 6.5M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  proyectos: (
    <>
      <circle className="i-sol" cx="12" cy="12" r="4" />
      <g className="i-rayos">
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </g>
    </>
  ),
  inversores: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path className="i-onda" d="M7 13c1.5-3 3-3 4.5 0s3 3 4.5 0" />
      <path d="M8 7h2M14 7h2" />
    </>
  ),
  usuarios: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  auditoria: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path className="i-lupa" d="m20 20-4.2-4.2" />
      <path className="i-linea" d="M8.5 11l1.8 1.8L14 9.2" />
    </>
  ),
  configuracion: (
    <g className="i-engranaje">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </g>
  ),
  estado: <path className="i-latido" d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1z" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  sol: (
    <>
      <circle cx="12" cy="12" r="4" />
      <g className="i-rayos">
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </g>
    </>
  ),
  luna: <path className="i-luna" d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,
  perfil: (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  salir: (
    <>
      <path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" />
      <path className="i-subir" d="M16 8l4 4-4 4M20 12H9" />
    </>
  ),
  buscar: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path className="i-lupa" d="m20 20-4.2-4.2" />
    </>
  ),
  mas: <path d="M12 5v14M5 12h14" />,
  imprimir: (
    <>
      <path d="M7 9V3h10v6" />
      <rect x="4" y="9" width="16" height="8" rx="1.5" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  descargar: (
    <>
      <path className="i-bajar" d="M12 4v11M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  alerta: (
    <>
      <path className="i-campana" d="M12 3 2.5 20h19z" />
      <path d="M12 10v4M12 17.2v.1" />
    </>
  ),
  ok: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path className="i-check" d="m8 12.3 2.8 2.8L16.5 9" />
    </>
  ),
  cerrar: <path d="M6 6l12 12M18 6 6 18" />,
  editar: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  flecha: <path className="i-flecha" d="M5 12h14M13 6l6 6-6 6" />,
};

export function Icono({
  nombre,
  tamano = 20,
  activo = false,
  titulo,
}: {
  nombre: NombreIcono;
  tamano?: number;
  /** Mantiene la animacion en marcha (p. ej. sincronizando). */
  activo?: boolean;
  titulo?: string;
}) {
  return (
    <svg
      className={`icono icono--${nombre}${activo ? ' icono--activo' : ''}`}
      width={tamano}
      height={tamano}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={titulo ? 'img' : undefined}
      aria-label={titulo}
      aria-hidden={titulo ? undefined : true}
      focusable="false"
    >
      {TRAZOS[nombre]}
    </svg>
  );
}
