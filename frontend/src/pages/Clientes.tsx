import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ErrorApi } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import { Confirmacion, MensajeError, MensajeExito, Modal } from '../components/Estados';
import { Icono } from '../components/Iconos';
import { Paginacion, Tabla } from '../components/Tabla';
import { fecha } from '../lib/formato';

interface Cliente {
  id_cliente: number;
  nombre: string;
  nit: string;
  ubicacion: string | null;
  contacto: string | null;
  telefono: string | null;
  email: string | null;
  activo: number;
  proyectos: number;
  created_at: string;
}

const VACIO = {
  nombre: '',
  nit: '',
  ubicacion: '',
  contacto: '',
  telefono: '',
  email: '',
  activo: true,
};

export function PaginaClientes() {
  const { puede } = useSesion();
  const clienteConsultas = useQueryClient();
  const listado = useListado<Cliente>('clientes', '/clients', { orden: 'nombre' });

  const [formulario, setFormulario] = useState<typeof VACIO | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [aEliminar, setAEliminar] = useState<Cliente | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const gestionar = puede('clientes.gestionar');

  const refrescar = () => {
    listado.recargar();
    void clienteConsultas.invalidateQueries({ queryKey: ['catalogo', 'clientes'] });
  };

  const abrirNuevo = () => {
    setEditando(null);
    setError(null);
    setFormulario({ ...VACIO });
  };

  const abrirEdicion = (cliente: Cliente) => {
    setEditando(cliente.id_cliente);
    setError(null);
    setFormulario({
      nombre: cliente.nombre,
      nit: cliente.nit,
      ubicacion: cliente.ubicacion ?? '',
      contacto: cliente.contacto ?? '',
      telefono: cliente.telefono ?? '',
      email: cliente.email ?? '',
      activo: Boolean(cliente.activo),
    });
  };

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!formulario) return;
    setOcupado(true);
    setError(null);
    try {
      const cuerpo = {
        ...formulario,
        ubicacion: formulario.ubicacion || null,
        contacto: formulario.contacto || null,
        telefono: formulario.telefono || null,
        email: formulario.email || null,
      };
      if (editando) {
        await api.actualizar(`/clients/${editando}`, cuerpo);
        setExito('Cliente actualizado correctamente.');
      } else {
        await api.crear('/clients', cuerpo);
        setExito('Cliente creado correctamente.');
      }
      setFormulario(null);
      refrescar();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const eliminar = async () => {
    if (!aEliminar) return;
    setOcupado(true);
    try {
      const respuesta = await api.eliminar<{ mensaje: string }>(`/clients/${aEliminar.id_cliente}`);
      setExito(respuesta.datos.mensaje);
      setAEliminar(null);
      refrescar();
    } catch (fallo) {
      setError(fallo);
      setAEliminar(null);
    } finally {
      setOcupado(false);
    }
  };

  const erroresCampo = error instanceof ErrorApi ? error.erroresPorCampo : {};

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Clientes</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Empresas propietarias de los proyectos fotovoltaicos administrados por Retse, S.A.
          </p>
        </div>
        {gestionar ? (
          <button type="button" className="boton" onClick={abrirNuevo}>
            <Icono nombre="mas" tamano={18} /> Nuevo cliente
          </button>
        ) : null}
      </div>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error && !formulario ? <MensajeError error={error} /> : null}

      <section className="tarjeta">
        <div className="filtros no-imprimir">
          <CampoTexto
            etiqueta="Buscar"
            type="search"
            placeholder="Nombre, NIT o ubicacion"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
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

        <Tabla<Cliente>
          titulo="Listado de clientes"
          columnas={[
            { clave: 'nombre', titulo: 'Nombre', orden: 'nombre', render: (f) => f.nombre },
            { clave: 'nit', titulo: 'NIT', orden: 'nit', render: (f) => f.nit },
            { clave: 'ubicacion', titulo: 'Ubicacion', render: (f) => f.ubicacion ?? '—' },
            { clave: 'contacto', titulo: 'Contacto', render: (f) => f.contacto ?? '—' },
            {
              clave: 'proyectos',
              titulo: 'Proyectos',
              numerica: true,
              render: (f) =>
                f.proyectos > 0 ? (
                  <Link to={`/proyectos?cliente=${f.id_cliente}`}>{f.proyectos}</Link>
                ) : (
                  '0'
                ),
            },
            {
              clave: 'estado',
              titulo: 'Estado',
              render: (f) => (
                <span className={f.activo ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--gris'}>
                  {f.activo ? 'Activo' : 'Inactivo'}
                </span>
              ),
            },
            { clave: 'creado', titulo: 'Registrado', orden: 'creado', render: (f) => fecha(f.created_at) },
            ...(gestionar
              ? [
                  {
                    clave: 'acciones',
                    titulo: 'Acciones',
                    render: (f: Cliente) => (
                      <div className="acciones no-imprimir">
                        <button
                          type="button"
                          className="boton boton--secundario boton--pequeno"
                          onClick={() => abrirEdicion(f)}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="boton boton--peligro boton--pequeno"
                          onClick={() => setAEliminar(f)}
                        >
                          {f.proyectos > 0 ? 'Desactivar' : 'Eliminar'}
                        </button>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_cliente}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          ordenActual={listado.estado.orden}
          direccionActual={listado.estado.direccion}
          alOrdenar={listado.ordenar}
          vacioTitulo="No hay clientes registrados"
          vacioDescripcion={
            gestionar
              ? 'Registre el primer cliente para poder crear proyectos solares.'
              : 'Solicite al administrador el registro de clientes.'
          }
          accionVacio={
            gestionar ? (
              <button type="button" className="boton" onClick={abrirNuevo}>
                Nuevo cliente
              </button>
            ) : undefined
          }
          pie={
            listado.meta ? (
              <Paginacion {...listado.meta} alCambiar={listado.irAPagina} />
            ) : undefined
          }
        />
      </section>

      {formulario ? (
        <Modal titulo={editando ? 'Editar cliente' : 'Nuevo cliente'} alCerrar={() => setFormulario(null)}>
          {error ? <MensajeError error={error} /> : null}
          <form onSubmit={guardar} noValidate>
            <div className="formulario">
              <CampoTexto
                etiqueta="Nombre o razon social"
                obligatorio
                ancho
                value={formulario.nombre}
                error={erroresCampo.nombre}
                onChange={(e) => setFormulario({ ...formulario, nombre: e.target.value })}
              />
              <CampoTexto
                etiqueta="NIT"
                obligatorio
                value={formulario.nit}
                error={erroresCampo.nit}
                ayuda="El formato aceptado se configura en el modulo de Configuracion."
                onChange={(e) => setFormulario({ ...formulario, nit: e.target.value })}
              />
              <CampoTexto
                etiqueta="Ubicacion"
                value={formulario.ubicacion}
                onChange={(e) => setFormulario({ ...formulario, ubicacion: e.target.value })}
              />
              <CampoTexto
                etiqueta="Persona de contacto"
                value={formulario.contacto}
                onChange={(e) => setFormulario({ ...formulario, contacto: e.target.value })}
              />
              <CampoTexto
                etiqueta="Telefono"
                value={formulario.telefono}
                onChange={(e) => setFormulario({ ...formulario, telefono: e.target.value })}
              />
              <CampoTexto
                etiqueta="Correo electronico"
                type="email"
                value={formulario.email}
                error={erroresCampo.email}
                onChange={(e) => setFormulario({ ...formulario, email: e.target.value })}
              />
              <CampoCasilla
                etiqueta="Cliente activo"
                ancho
                checked={formulario.activo}
                onChange={(e) => setFormulario({ ...formulario, activo: e.target.checked })}
              />
            </div>
            <div className="acciones" style={{ marginTop: '1.1rem', justifyContent: 'flex-end' }}>
              <button type="button" className="boton boton--secundario" onClick={() => setFormulario(null)}>
                Cancelar
              </button>
              <button type="submit" className="boton" disabled={ocupado}>
                {ocupado ? 'Guardando...' : 'Guardar cliente'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {aEliminar ? (
        <Confirmacion
          titulo={aEliminar.proyectos > 0 ? 'Desactivar cliente' : 'Eliminar cliente'}
          peligroso
          ocupado={ocupado}
          textoConfirmar={aEliminar.proyectos > 0 ? 'Desactivar' : 'Eliminar'}
          descripcion={
            aEliminar.proyectos > 0 ? (
              <p>
                <strong>{aEliminar.nombre}</strong> tiene {aEliminar.proyectos} proyecto(s) asociado(s), por
                lo que no puede eliminarse. Se desactivara para conservar la trazabilidad historica.
              </p>
            ) : (
              <p>
                Se eliminara permanentemente el cliente <strong>{aEliminar.nombre}</strong>. Esta accion no
                se puede deshacer.
              </p>
            )
          }
          alConfirmar={eliminar}
          alCancelar={() => setAEliminar(null)}
        />
      ) : null}
    </>
  );
}
