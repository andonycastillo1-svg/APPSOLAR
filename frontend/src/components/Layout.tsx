import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NOMBRE_ROL, useSesion } from '../lib/auth';
import { MensajeAlerta } from './Estados';

interface Enlace {
  a: string;
  texto: string;
  icono: string;
  permisos?: string[];
}

interface Grupo {
  titulo: string;
  enlaces: Enlace[];
}

const NAVEGACION: Grupo[] = [
  {
    titulo: 'Analisis',
    enlaces: [
      { a: '/', texto: 'Tablero', icono: '◧', permisos: ['dashboard.ver'] },
      { a: '/resumen-anual', texto: 'Resumen anual', icono: '▦', permisos: ['produccion.ver'] },
      { a: '/reportes', texto: 'Reportes', icono: '▤', permisos: ['reportes.ver'] },
    ],
  },
  {
    titulo: 'Operacion',
    enlaces: [
      { a: '/produccion', texto: 'Produccion', icono: '⚡', permisos: ['produccion.ver'] },
      { a: '/importaciones', texto: 'Carga de historicos', icono: '⇧', permisos: ['importaciones.ver'] },
      { a: '/integracion', texto: 'Integracion Huawei', icono: '⟳', permisos: ['huawei.ver'] },
    ],
  },
  {
    titulo: 'Catalogos',
    enlaces: [
      { a: '/clientes', texto: 'Clientes', icono: '◆', permisos: ['clientes.ver'] },
      { a: '/proyectos', texto: 'Proyectos solares', icono: '☀', permisos: ['proyectos.ver'] },
      { a: '/inversores', texto: 'Inversores', icono: '▣', permisos: ['inversores.ver'] },
    ],
  },
  {
    titulo: 'Administracion',
    enlaces: [
      { a: '/usuarios', texto: 'Usuarios y permisos', icono: '☖', permisos: ['usuarios.ver'] },
      { a: '/auditoria', texto: 'Auditoria', icono: '☰', permisos: ['auditoria.ver'] },
      { a: '/configuracion', texto: 'Configuracion', icono: '⚙', permisos: ['config.ver'] },
      { a: '/estado', texto: 'Estado de servicios', icono: '♥', permisos: ['salud.ver'] },
    ],
  },
];

export function Layout() {
  const { usuario, cerrarSesion, puedeAlguno, debeCambiarPassword } = useSesion();
  const [menuAbierto, setMenuAbierto] = useState(false);
  const navegar = useNavigate();
  const ubicacion = useLocation();

  useEffect(() => {
    setMenuAbierto(false);
  }, [ubicacion.pathname]);

  const grupos = NAVEGACION.map((grupo) => ({
    ...grupo,
    enlaces: grupo.enlaces.filter((enlace) => !enlace.permisos || puedeAlguno(...enlace.permisos)),
  })).filter((grupo) => grupo.enlaces.length > 0);

  return (
    <div className="app">
      <a className="saltar-al-contenido" href="#contenido-principal">
        Saltar al contenido principal
      </a>

      <aside className="lateral" data-abierto={menuAbierto} id="menu-lateral">
        <div className="lateral__marca">
          <span>Retse, S.A.</span>
          <strong>Monitoreo Energetico</strong>
        </div>
        <nav aria-label="Navegacion principal">
          {grupos.map((grupo) => (
            <div key={grupo.titulo}>
              <p className="lateral__grupo">{grupo.titulo}</p>
              {grupo.enlaces.map((enlace) => (
                <NavLink key={enlace.a} to={enlace.a} end={enlace.a === '/'}>
                  <span aria-hidden="true">{enlace.icono}</span>
                  {enlace.texto}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <header className="encabezado">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
          <button
            type="button"
            className="boton boton--secundario boton--pequeno menu-movil"
            aria-expanded={menuAbierto}
            aria-controls="menu-lateral"
            onClick={() => setMenuAbierto((valor) => !valor)}
          >
            <span aria-hidden="true">☰</span> Menu
          </button>
          <strong style={{ fontSize: '0.95rem' }}>Sistema Centralizado de Monitoreo Energetico</strong>
        </div>

        <div className="encabezado__usuario">
          <div style={{ textAlign: 'right' }}>
            <div className="nombre">{usuario?.nombre}</div>
            <span className="rol">{usuario ? NOMBRE_ROL[usuario.rol] : ''}</span>
          </div>
          <button
            type="button"
            className="boton boton--secundario boton--pequeno"
            onClick={() => navegar('/perfil')}
          >
            Mi perfil
          </button>
          <button
            type="button"
            className="boton boton--secundario boton--pequeno"
            onClick={() => {
              void cerrarSesion().then(() => navegar('/ingresar'));
            }}
          >
            Cerrar sesion
          </button>
        </div>
      </header>

      <main className="contenido" id="contenido-principal" tabIndex={-1}>
        {debeCambiarPassword && ubicacion.pathname !== '/perfil' ? (
          <MensajeAlerta titulo="Debe cambiar su contrasena">
            Su contrasena fue asignada por un administrador.{' '}
            <a href="/perfil" onClick={(e) => { e.preventDefault(); navegar('/perfil'); }}>
              Cambiela ahora
            </a>{' '}
            para continuar trabajando con seguridad.
          </MensajeAlerta>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
