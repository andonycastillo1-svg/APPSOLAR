import { useState, type FormEvent } from 'react';
import { Icono } from '../components/Iconos';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorApi } from '../lib/api';
import { NOMBRE_ROL, useSesion, type RolCodigo } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import {
  Cargando,
  Confirmacion,
  MensajeAlerta,
  MensajeError,
  MensajeExito,
  MensajeInfo,
  Modal,
} from '../components/Estados';
import { Paginacion, Tabla } from '../components/Tabla';
import { fechaHora } from '../lib/formato';

interface Usuario {
  id_usuario: number;
  nombre: string;
  email: string;
  telefono: string | null;
  activo: number;
  ultimo_acceso: string | null;
  debe_cambiar_password: number;
  es_demo: number;
  rol: RolCodigo;
  rol_nombre: string;
  created_at: string;
}

interface DetalleUsuario extends Usuario {
  permisosEfectivos: string[];
  permisosIndividuales: Array<{ codigo: string; otorgado: number }>;
}

interface Permiso {
  id_permiso: number;
  codigo: string;
  modulo: string;
  descripcion: string;
}

const VACIO = {
  nombre: '',
  email: '',
  rol: 'OPERATIVO' as RolCodigo,
  telefono: '',
  activo: true,
};

export function PaginaUsuarios() {
  const { puede, usuario: sesion } = useSesion();
  const listado = useListado<Usuario>('usuarios', '/users', { orden: 'nombre' });

  const [formulario, setFormulario] = useState<typeof VACIO | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [permisosDe, setPermisosDe] = useState<number | null>(null);
  const [restablecer, setRestablecer] = useState<Usuario | null>(null);
  const [credencial, setCredencial] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [seleccionPermisos, setSeleccionPermisos] = useState<Record<string, boolean>>({});

  const gestionar = puede('usuarios.gestionar');

  const catalogoRoles = useQuery({
    queryKey: ['roles-permisos'],
    queryFn: async () =>
      (await api.obtener<{ roles: Array<{ codigo: string; nombre: string; descripcion: string }>; permisos: Permiso[] }>(
        '/users/roles',
      )).datos,
  });

  const detalle = useQuery({
    queryKey: ['usuario', permisosDe],
    enabled: permisosDe !== null,
    queryFn: async () => {
      const respuesta = await api.obtener<DetalleUsuario>(`/users/${permisosDe}`);
      const iniciales: Record<string, boolean> = {};
      respuesta.datos.permisosIndividuales.forEach((p) => {
        iniciales[p.codigo] = Boolean(p.otorgado);
      });
      setSeleccionPermisos(iniciales);
      return respuesta.datos;
    },
  });

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!formulario) return;
    setOcupado(true);
    setError(null);
    try {
      if (editando) {
        await api.actualizar(`/users/${editando}`, formulario);
        setExito('Usuario actualizado correctamente.');
      } else {
        const respuesta = await api.crear<{ passwordTemporal?: string; mensaje: string }>('/users', formulario);
        setExito(respuesta.datos.mensaje);
        if (respuesta.datos.passwordTemporal) {
          setCredencial({ email: formulario.email, password: respuesta.datos.passwordTemporal });
        }
      }
      setFormulario(null);
      listado.recargar();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const ejecutarRestablecer = async () => {
    if (!restablecer) return;
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await api.crear<{ passwordTemporal: string; mensaje: string }>(
        `/users/${restablecer.id_usuario}/reset-password`,
      );
      setCredencial({ email: restablecer.email, password: respuesta.datos.passwordTemporal });
      setExito(respuesta.datos.mensaje);
      setRestablecer(null);
      listado.recargar();
    } catch (fallo) {
      setError(fallo);
      setRestablecer(null);
    } finally {
      setOcupado(false);
    }
  };

  const guardarPermisos = async () => {
    if (permisosDe === null) return;
    setOcupado(true);
    setError(null);
    try {
      const otorgados = Object.entries(seleccionPermisos).filter(([, v]) => v).map(([k]) => k);
      const revocados = Object.entries(seleccionPermisos).filter(([, v]) => !v).map(([k]) => k);
      const respuesta = await api.actualizar<{ mensaje: string }>(`/users/${permisosDe}/permissions`, {
        otorgados,
        revocados,
      });
      setExito(respuesta.datos.mensaje);
      setPermisosDe(null);
      listado.recargar();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const erroresCampo = error instanceof ErrorApi ? error.erroresPorCampo : {};

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Usuarios y permisos</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            El coordinador de tarifas es un usuario operativo con el permiso individual{' '}
            <code>tarifas.gestionar</code>: no existe un cuarto rol global.
          </p>
        </div>
        {gestionar ? (
          <button
            type="button"
            className="boton"
            onClick={() => {
              setEditando(null);
              setError(null);
              setFormulario({ ...VACIO });
            }}
          >
            <Icono nombre="mas" tamano={18} /> Nuevo usuario
          </button>
        ) : null}
      </div>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error && !formulario && permisosDe === null ? <MensajeError error={error} /> : null}

      <section className="tarjeta">
        <div className="filtros no-imprimir">
          <CampoTexto
            etiqueta="Buscar"
            type="search"
            placeholder="Nombre o correo"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
          <CampoSelect
            etiqueta="Rol"
            value={String(listado.estado.rol ?? '')}
            onChange={(e) => listado.actualizar({ rol: e.target.value })}
          >
            <option value="">Todos</option>
            <option value="ADMINISTRATIVO">Administrativo</option>
            <option value="OPERATIVO">Operativo</option>
            <option value="GERENCIAL">Gerencial</option>
          </CampoSelect>
          <CampoSelect
            etiqueta="Estado"
            value={String(listado.estado.activo ?? '')}
            onChange={(e) => listado.actualizar({ activo: e.target.value })}
          >
            <option value="">Todos</option>
            <option value="1">Activos</option>
            <option value="0">Inactivos</option>
          </CampoSelect>
        </div>

        <Tabla<Usuario>
          titulo="Listado de usuarios"
          columnas={[
            {
              clave: 'nombre',
              titulo: 'Nombre',
              orden: 'nombre',
              render: (f) => (
                <>
                  {f.nombre}
                  {f.es_demo ? (
                    <span className="etiqueta etiqueta--azul" style={{ marginLeft: '0.35rem' }}>
                      Demostracion
                    </span>
                  ) : null}
                </>
              ),
            },
            { clave: 'email', titulo: 'Correo', orden: 'email', render: (f) => f.email },
            {
              clave: 'rol',
              titulo: 'Rol',
              orden: 'rol',
              render: (f) => <span className="etiqueta etiqueta--gris">{NOMBRE_ROL[f.rol]}</span>,
            },
            {
              clave: 'estado',
              titulo: 'Estado',
              render: (f) => (
                <>
                  <span className={f.activo ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--gris'}>
                    {f.activo ? 'Activo' : 'Inactivo'}
                  </span>
                  {f.debe_cambiar_password ? (
                    <span className="etiqueta etiqueta--ambar" style={{ marginLeft: '0.3rem' }}>
                      Debe cambiar contraseña
                    </span>
                  ) : null}
                </>
              ),
            },
            {
              clave: 'acceso',
              titulo: 'Ultimo acceso',
              orden: 'ultimoAcceso',
              render: (f) => fechaHora(f.ultimo_acceso),
            },
            ...(gestionar
              ? [
                  {
                    clave: 'acciones',
                    titulo: 'Acciones',
                    render: (f: Usuario) => (
                      <div className="acciones no-imprimir">
                        <button
                          type="button"
                          className="boton boton--secundario boton--pequeno"
                          onClick={() => {
                            setEditando(f.id_usuario);
                            setError(null);
                            setFormulario({
                              nombre: f.nombre,
                              email: f.email,
                              rol: f.rol,
                              telefono: f.telefono ?? '',
                              activo: Boolean(f.activo),
                            });
                          }}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="boton boton--secundario boton--pequeno"
                          onClick={() => {
                            setError(null);
                            setPermisosDe(f.id_usuario);
                          }}
                        >
                          Permisos
                        </button>
                        <button
                          type="button"
                          className="boton boton--peligro boton--pequeno"
                          onClick={() => setRestablecer(f)}
                        >
                          Restablecer acceso
                        </button>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_usuario}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          ordenActual={listado.estado.orden}
          direccionActual={listado.estado.direccion}
          alOrdenar={listado.ordenar}
          vacioTitulo="No hay usuarios que coincidan con el filtro"
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>

      {/* --------------------------- Formulario --------------------------- */}
      {formulario ? (
        <Modal titulo={editando ? 'Editar usuario' : 'Nuevo usuario'} alCerrar={() => setFormulario(null)}>
          {error ? <MensajeError error={error} /> : null}
          {!editando ? (
            <MensajeInfo>
              El sistema generara una contraseña temporal segura. El usuario debera cambiarla en su primer
              ingreso. Las contraseñas existentes nunca se muestran ni se recuperan.
            </MensajeInfo>
          ) : null}
          {editando === sesion?.id_usuario ? (
            <MensajeAlerta>
              Esta editando su propio usuario. No puede desactivarse a si mismo ni dejar el sistema sin
              administradores activos.
            </MensajeAlerta>
          ) : null}
          <form onSubmit={guardar} noValidate>
            <div className="formulario">
              <CampoTexto
                etiqueta="Nombre completo"
                obligatorio
                value={formulario.nombre}
                error={erroresCampo.nombre}
                onChange={(e) => setFormulario({ ...formulario, nombre: e.target.value })}
              />
              <CampoTexto
                etiqueta="Correo electronico"
                type="email"
                obligatorio
                value={formulario.email}
                error={erroresCampo.email}
                onChange={(e) => setFormulario({ ...formulario, email: e.target.value })}
              />
              <CampoSelect
                etiqueta="Rol"
                obligatorio
                value={formulario.rol}
                error={erroresCampo.rol}
                onChange={(e) => setFormulario({ ...formulario, rol: e.target.value as RolCodigo })}
              >
                {catalogoRoles.data?.roles.map((r) => (
                  <option key={r.codigo} value={r.codigo}>{r.nombre}</option>
                ))}
              </CampoSelect>
              <CampoTexto
                etiqueta="Telefono"
                value={formulario.telefono}
                onChange={(e) => setFormulario({ ...formulario, telefono: e.target.value })}
              />
              <CampoCasilla
                etiqueta="Usuario activo"
                ancho
                checked={formulario.activo}
                onChange={(e) => setFormulario({ ...formulario, activo: e.target.checked })}
              />
            </div>

            {catalogoRoles.data ? (
              <fieldset style={{ marginTop: '1rem' }}>
                <legend>Descripcion del rol seleccionado</legend>
                <p style={{ fontSize: '0.85rem', margin: 0 }}>
                  {catalogoRoles.data.roles.find((r) => r.codigo === formulario.rol)?.descripcion}
                </p>
              </fieldset>
            ) : null}

            <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button type="button" className="boton boton--secundario" onClick={() => setFormulario(null)}>
                Cancelar
              </button>
              <button type="submit" className="boton" disabled={ocupado}>
                {ocupado ? 'Guardando...' : 'Guardar usuario'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* --------------------------- Permisos individuales --------------------------- */}
      {permisosDe !== null ? (
        <Modal titulo="Permisos individuales" ancho alCerrar={() => setPermisosDe(null)}>
          {error ? <MensajeError error={error} /> : null}
          {detalle.isLoading ? <Cargando /> : null}
          {detalle.data ? (
            <>
              <p style={{ fontSize: '0.88rem' }}>
                <strong>{detalle.data.nombre}</strong> · {detalle.data.email} ·{' '}
                <span className="etiqueta etiqueta--gris">{NOMBRE_ROL[detalle.data.rol]}</span>
              </p>

              <MensajeInfo>
                Marque un permiso para <strong>otorgarlo</strong> individualmente; desmarquelo para{' '}
                <strong>revocarlo</strong> aunque su rol lo incluya. Los permisos no listados aqui siguen la
                configuracion del rol. El rol gerencial nunca puede recibir permisos de escritura.
              </MensajeInfo>

              <h3>Permisos efectivos actuales</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '1rem' }}>
                {detalle.data.permisosEfectivos.map((p) => (
                  <span key={p} className="etiqueta etiqueta--azul">{p}</span>
                ))}
              </div>

              <h3>Ajustes individuales</h3>
              {catalogoRoles.data
                ? Object.entries(
                    catalogoRoles.data.permisos.reduce<Record<string, Permiso[]>>((acc, permiso) => {
                      (acc[permiso.modulo] ??= []).push(permiso);
                      return acc;
                    }, {}),
                  ).map(([modulo, permisos]) => (
                    <fieldset key={modulo}>
                      <legend>{modulo}</legend>
                      {permisos.map((permiso) => (
                        <div key={permiso.codigo} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.3rem' }}>
                          <input
                            type="checkbox"
                            id={`permiso-${permiso.codigo}`}
                            style={{ width: 'auto', marginTop: '0.25rem' }}
                            checked={seleccionPermisos[permiso.codigo] ?? false}
                            ref={(elemento) => {
                              if (elemento) {
                                elemento.indeterminate = !(permiso.codigo in seleccionPermisos);
                              }
                            }}
                            onChange={(e) =>
                              setSeleccionPermisos({ ...seleccionPermisos, [permiso.codigo]: e.target.checked })
                            }
                          />
                          <label htmlFor={`permiso-${permiso.codigo}`} style={{ fontWeight: 500, fontSize: '0.84rem' }}>
                            <code>{permiso.codigo}</code> — {permiso.descripcion}
                          </label>
                        </div>
                      ))}
                    </fieldset>
                  ))
                : null}

              <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
                <button type="button" className="boton boton--secundario" onClick={() => setPermisosDe(null)}>
                  Cancelar
                </button>
                <button type="button" className="boton" onClick={() => void guardarPermisos()} disabled={ocupado}>
                  {ocupado ? 'Guardando...' : 'Guardar permisos'}
                </button>
              </div>
            </>
          ) : null}
        </Modal>
      ) : null}

      {/* --------------------------- Restablecer --------------------------- */}
      {restablecer ? (
        <Confirmacion
          titulo="Restablecer el acceso del usuario"
          peligroso
          ocupado={ocupado}
          textoConfirmar="Generar contraseña temporal"
          descripcion={
            <p>
              Se generara una contraseña temporal para <strong>{restablecer.nombre}</strong>, se cerraran sus
              sesiones activas y debera cambiarla al ingresar. La contraseña anterior no se revela en ningun
              momento.
            </p>
          }
          alConfirmar={ejecutarRestablecer}
          alCancelar={() => setRestablecer(null)}
        />
      ) : null}

      {/* --------------------------- Credencial temporal --------------------------- */}
      {credencial ? (
        <Modal titulo="Contraseña temporal generada" alCerrar={() => setCredencial(null)}>
          <MensajeAlerta titulo="Se muestra una sola vez">
            Copie la contraseña y entreguela por un medio seguro. No se volvera a mostrar y no queda
            registrada en la auditoria ni en los logs.
          </MensajeAlerta>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.4rem 1rem', fontSize: '0.9rem' }}>
            <dt style={{ fontWeight: 640 }}>Usuario</dt>
            <dd style={{ margin: 0 }}>{credencial.email}</dd>
            <dt style={{ fontWeight: 640 }}>Contraseña temporal</dt>
            <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: '1.05rem', letterSpacing: '0.04em' }}>
              {credencial.password}
            </dd>
          </dl>
          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="boton boton--secundario"
              onClick={() => void navigator.clipboard?.writeText(credencial.password)}
            >
              Copiar al portapapeles
            </button>
            <button type="button" className="boton" onClick={() => setCredencial(null)}>
              Ya la resguarde
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
