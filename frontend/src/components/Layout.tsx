import { Fragment, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, ErrorApi } from '../lib/api';
import { NOMBRE_ROL, useSesion } from '../lib/auth';
import { MensajeAlerta } from './Estados';
import { Icono, type NombreIcono } from './Iconos';
import { cambiarTema, useTema } from '../lib/tema';

interface Enlace {
  a: string;
  texto: string;
  icono: NombreIcono;
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
      { a: '/', texto: 'Tablero', icono: 'tablero', permisos: ['dashboard.ver'] },
      { a: '/resumen-anual', texto: 'Resumen anual', icono: 'resumen', permisos: ['produccion.ver'] },
      { a: '/reportes', texto: 'Reportes', icono: 'reportes', permisos: ['reportes.ver'] },
    ],
  },
  {
    titulo: 'Operacion',
    enlaces: [
      { a: '/produccion', texto: 'Produccion', icono: 'produccion', permisos: ['produccion.ver'] },
      { a: '/importaciones', texto: 'Carga de historicos', icono: 'importar', permisos: ['importaciones.ver'] },
      { a: '/integracion', texto: 'Integracion Huawei', icono: 'sincronizar', permisos: ['huawei.ver'] },
    ],
  },
  {
    titulo: 'Catalogos',
    enlaces: [
      { a: '/clientes', texto: 'Clientes', icono: 'clientes', permisos: ['clientes.ver'] },
      { a: '/proyectos', texto: 'Proyectos solares', icono: 'proyectos', permisos: ['proyectos.ver'] },
      { a: '/inversores', texto: 'Inversores', icono: 'inversores', permisos: ['inversores.ver'] },
    ],
  },
  {
    titulo: 'Administracion',
    enlaces: [
      { a: '/usuarios', texto: 'Usuarios y permisos', icono: 'usuarios', permisos: ['usuarios.ver'] },
      { a: '/auditoria', texto: 'Auditoria', icono: 'auditoria', permisos: ['auditoria.ver'] },
      { a: '/configuracion', texto: 'Configuracion', icono: 'configuracion', permisos: ['config.ver'] },
      { a: '/estado', texto: 'Estado de servicios', icono: 'estado', permisos: ['salud.ver'] },
    ],
  },
];

interface ResultadoSincronizacionAhora {
  estado: string;
  insertadas: number;
  actualizadas: number;
  rechazadas: number;
  hasta: string;
  mensaje: string;
  advertencias: string[];
  esSimulado: boolean;
  proyectosNuevos: string[];
  inversoresSinDatos: string[];
}

/**
 * Botón del menú principal: trae de Huawei toda la producción hasta este
 * momento, sin pedir fechas. Repetirlo es seguro: actualiza, no suma.
 */
function BotonSincronizarAhora({ alTerminar }: { alTerminar: () => void }) {
  const [estado, setEstado] = useState<'reposo' | 'sincronizando'>('reposo');
  const [resultado, setResultado] = useState<{ tipo: 'exito' | 'aviso' | 'error'; texto: string; detalle?: string[] } | null>(null);

  async function sincronizar() {
    setEstado('sincronizando');
    setResultado(null);
    try {
      const r = await api.crear<ResultadoSincronizacionAhora>('/integrations/huawei/sync-now', {});
      const d = r.datos;
      const conAvisos = d.estado !== 'COMPLETADA' || d.advertencias.length > 0;
      setResultado({
        tipo: conAvisos ? 'aviso' : 'exito',
        texto: `${d.esSimulado ? '(Datos simulados) ' : ''}${d.mensaje}`,
        detalle: d.advertencias.slice(0, 4),
      });
      alTerminar();
    } catch (error) {
      setResultado({
        tipo: 'error',
        texto: error instanceof ErrorApi || error instanceof Error ? error.message : 'No se pudo sincronizar.',
      });
    } finally {
      setEstado('reposo');
    }
  }

  return (
    <div className="lateral__sync">
      <button
        type="button"
        className="boton boton--verde lateral__sync-boton"
        onClick={() => void sincronizar()}
        disabled={estado === 'sincronizando'}
        aria-busy={estado === 'sincronizando'}
      >
        <Icono nombre="sincronizar" activo={estado === 'sincronizando'} />
        {estado === 'sincronizando' ? 'Sincronizando…' : 'Sincronizar ahora'}
      </button>
      <p className="lateral__sync-ayuda">Trae toda la producción de Huawei hasta este momento.</p>
      {estado === 'sincronizando' ? (
        <p className="lateral__sync-resultado" role="status">
          Consultando a Huawei, esto puede tardar un minuto…
        </p>
      ) : null}
      {resultado ? (
        <div className={`lateral__sync-resultado lateral__sync-resultado--${resultado.tipo}`} role={resultado.tipo === 'error' ? 'alert' : 'status'}>
          {resultado.texto}
          {resultado.detalle && resultado.detalle.length > 0 ? (
            <ul>
              {resultado.detalle.map((linea) => (
                <li key={linea}>{linea}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Layout() {
  const { usuario, cerrarSesion, puede, puedeAlguno, debeCambiarPassword } = useSesion();
  const [menuAbierto, setMenuAbierto] = useState(false);
  // Al terminar una sincronización se vuelve a montar la pantalla activa para que muestre los datos nuevos.
  const [versionDatos, setVersionDatos] = useState(0);
  const navegar = useNavigate();
  const ubicacion = useLocation();
  const tema = useTema();

  useEffect(() => {
    setMenuAbierto(false);
  }, [ubicacion.pathname]);

  const iniciales = (usuario?.nombre ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((palabra) => palabra[0]?.toUpperCase() ?? '')
    .join('');

  // Seccion y pantalla actuales, para la miga de pan del encabezado.
  const rutaActual = NAVEGACION.flatMap((g) => g.enlaces.map((e) => ({ ...e, grupo: g.titulo }))).find((e) =>
    e.a === '/' ? ubicacion.pathname === '/' : ubicacion.pathname.startsWith(e.a),
  );

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
          <span className="lateral__logo" aria-hidden="true">
            <Icono nombre="proyectos" tamano={24} />
          </span>
          <div className="lateral__titulos">
            <span>Retse, S.A.</span>
            <strong>Monitoreo Energetico</strong>
          </div>
        </div>
        <nav aria-label="Navegacion principal">
          {grupos.map((grupo) => (
            <div key={grupo.titulo}>
              <p className="lateral__grupo">{grupo.titulo}</p>
              {grupo.enlaces.map((enlace) => (
                <NavLink key={enlace.a} to={enlace.a} end={enlace.a === '/'}>
                  <Icono nombre={enlace.icono} />
                  {enlace.texto}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {puede('produccion.sincronizar_ahora') ? (
          <BotonSincronizarAhora alTerminar={() => setVersionDatos((v) => v + 1)} />
        ) : null}
      </aside>
      <div className="velo-menu" onClick={() => setMenuAbierto(false)} aria-hidden="true" />

      <header className="encabezado">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
          <button
            type="button"
            className="boton boton--secundario boton--pequeno menu-movil"
            aria-expanded={menuAbierto}
            aria-controls="menu-lateral"
            onClick={() => setMenuAbierto((valor) => !valor)}
          >
            <Icono nombre="menu" tamano={18} /> Menu
          </button>
          <div>
            <span className="encabezado__migas">{rutaActual?.grupo ?? 'Sistema'}</span>
            <strong className="encabezado__titulo">
              {rutaActual?.texto ?? 'Sistema Centralizado de Monitoreo Energetico'}
            </strong>
          </div>
        </div>

        <div className="encabezado__usuario">
          <button
            type="button"
            className="boton-icono"
            onClick={() => cambiarTema()}
            aria-label={tema === 'oscuro' ? 'Cambiar al tema claro' : 'Cambiar al tema oscuro'}
            title={tema === 'oscuro' ? 'Tema claro' : 'Tema oscuro'}
          >
            <Icono nombre={tema === 'oscuro' ? 'sol' : 'luna'} />
          </button>
          <span className="avatar" aria-hidden="true">{iniciales}</span>
          <div style={{ textAlign: 'right' }}>
            <div className="nombre">{usuario?.nombre}</div>
            <span className="rol">{usuario ? NOMBRE_ROL[usuario.rol] : ''}</span>
          </div>
          <button
            type="button"
            className="boton boton--secundario boton--pequeno"
            onClick={() => navegar('/perfil')}
          >
            <Icono nombre="perfil" tamano={16} /> Mi perfil
          </button>
          <button
            type="button"
            className="boton boton--secundario boton--pequeno"
            onClick={() => {
              void cerrarSesion().then(() => navegar('/ingresar'));
            }}
          >
            <Icono nombre="salir" tamano={16} /> Cerrar sesion
          </button>
        </div>
      </header>

      <main className="contenido" id="contenido-principal" tabIndex={-1}>
        {debeCambiarPassword && ubicacion.pathname !== '/perfil' ? (
          <MensajeAlerta titulo="Debe cambiar su contraseña">
            Su contraseña fue asignada por un administrador.{' '}
            <a href="/perfil" onClick={(e) => { e.preventDefault(); navegar('/perfil'); }}>
              Cambiela ahora
            </a>{' '}
            para continuar trabajando con seguridad.
          </MensajeAlerta>
        ) : null}
        <Fragment key={versionDatos}>
          <Outlet />
        </Fragment>
      </main>
    </div>
  );
}
