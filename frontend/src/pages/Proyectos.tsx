import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ErrorApi } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { useCatalogos } from '../hooks/useCatalogos';
import { CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import { Confirmacion, MensajeError, MensajeExito, MensajeInfo, Modal } from '../components/Estados';
import { Paginacion, Tabla } from '../components/Tabla';
import { fecha, kwh, kwp, quetzales } from '../lib/formato';

interface Proyecto {
  id_proyecto: number;
  id_cliente: number;
  nombre: string;
  cliente: string;
  ubicacion: string | null;
  tipo_proyecto: string;
  capacidad_kwp: number | null;
  fecha_inicio: string | null;
  activo: number;
  inversores: number;
  kwh_por_inversor: number;
  kwh_consolidado: number;
  valor_q_total: number;
  registros_pendientes: number;
  ultima_produccion: string | null;
}

const VACIO = {
  id_cliente: '',
  nombre: '',
  ubicacion: '',
  tipo_proyecto: 'OTRO',
  capacidad_kwp: '',
  fecha_inicio: '',
  observaciones: '',
  activo: true,
};

export function PaginaProyectos() {
  const { puede } = useSesion();
  const catalogos = useCatalogos();
  const clienteConsultas = useQueryClient();
  const [parametros] = useSearchParams();

  const listado = useListado<Proyecto>('proyectos', '/projects', { orden: 'nombre' });

  useEffect(() => {
    const cliente = parametros.get('cliente');
    if (cliente) listado.actualizar({ id_cliente: cliente });
    // Solo debe ejecutarse cuando cambia el parametro de la URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parametros]);

  const [formulario, setFormulario] = useState<typeof VACIO | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [aEliminar, setAEliminar] = useState<Proyecto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const gestionar = puede('proyectos.gestionar');

  const refrescar = () => {
    listado.recargar();
    void clienteConsultas.invalidateQueries({ queryKey: ['catalogo', 'proyectos'] });
  };

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!formulario) return;
    setOcupado(true);
    setError(null);
    try {
      const cuerpo = {
        ...formulario,
        id_cliente: Number(formulario.id_cliente),
        capacidad_kwp: formulario.capacidad_kwp === '' ? null : Number(formulario.capacidad_kwp),
        ubicacion: formulario.ubicacion || null,
        fecha_inicio: formulario.fecha_inicio || null,
        observaciones: formulario.observaciones || null,
      };
      if (editando) {
        await api.actualizar(`/projects/${editando}`, cuerpo);
        setExito('Proyecto actualizado correctamente.');
      } else {
        await api.crear('/projects', cuerpo);
        setExito('Proyecto creado correctamente.');
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
      const respuesta = await api.eliminar<{ mensaje: string }>(`/projects/${aEliminar.id_proyecto}`);
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
          <h1>Proyectos solares</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Cada proyecto administra sus tarifas mensuales de kWh y sus proyecciones de generacion.
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
            Nuevo proyecto
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
            placeholder="Proyecto, ubicacion o cliente"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
          <CampoSelect
            etiqueta="Cliente"
            value={String(listado.estado.id_cliente ?? '')}
            onChange={(e) => listado.actualizar({ id_cliente: e.target.value })}
          >
            <option value="">Todos los clientes</option>
            {catalogos.clientes.map((c) => (
              <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Modalidad comercial"
            value={String(listado.estado.tipo_proyecto ?? '')}
            onChange={(e) => listado.actualizar({ tipo_proyecto: e.target.value })}
          >
            <option value="">Todas</option>
            <option value="PPA">PPA</option>
            <option value="EPC">EPC</option>
            <option value="AUTOCONSUMO">Autoconsumo</option>
            <option value="OTRO">Otro</option>
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

        <Tabla<Proyecto>
          titulo="Listado de proyectos"
          descripcion="La produccion acumulada se muestra separada por nivel de detalle para evitar el doble conteo."
          columnas={[
            {
              clave: 'nombre',
              titulo: 'Proyecto',
              orden: 'nombre',
              render: (f) => <Link to={`/proyectos/${f.id_proyecto}`}>{f.nombre}</Link>,
            },
            { clave: 'cliente', titulo: 'Cliente', orden: 'cliente', render: (f) => f.cliente },
            {
              clave: 'tipo',
              titulo: 'Modalidad',
              orden: 'tipo',
              render: (f) => <span className="etiqueta etiqueta--azul">{f.tipo_proyecto}</span>,
            },
            { clave: 'kwp', titulo: 'Potencia', numerica: true, render: (f) => kwp(f.capacidad_kwp) },
            { clave: 'inv', titulo: 'Inversores', numerica: true, render: (f) => String(f.inversores) },
            {
              clave: 'produccion',
              titulo: 'Produccion acumulada',
              numerica: true,
              render: (f) => (
                <span>
                  {kwh(Number(f.kwh_por_inversor) + Number(f.kwh_consolidado))}
                  {Number(f.kwh_por_inversor) > 0 && Number(f.kwh_consolidado) > 0 ? (
                    <span className="etiqueta etiqueta--ambar" style={{ marginLeft: '0.3rem' }}>
                      Dos niveles
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              clave: 'valor',
              titulo: 'Valor acumulado',
              numerica: true,
              render: (f) => (
                <span>
                  {quetzales(f.valor_q_total)}
                  {f.registros_pendientes > 0 ? (
                    <span className="etiqueta etiqueta--ambar" style={{ marginLeft: '0.3rem' }}>
                      {f.registros_pendientes} pendiente(s)
                    </span>
                  ) : null}
                </span>
              ),
            },
            { clave: 'ultima', titulo: 'Ultimo dato', render: (f) => fecha(f.ultima_produccion) },
            {
              clave: 'estado',
              titulo: 'Estado',
              render: (f) => (
                <span className={f.activo ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--gris'}>
                  {f.activo ? 'Activo' : 'Inactivo'}
                </span>
              ),
            },
            {
              clave: 'acciones',
              titulo: 'Acciones',
              render: (f) => (
                <div className="acciones no-imprimir">
                  <Link className="boton boton--secundario boton--pequeno" to={`/proyectos/${f.id_proyecto}`}>
                    Detalle
                  </Link>
                  {gestionar ? (
                    <>
                      <button
                        type="button"
                        className="boton boton--secundario boton--pequeno"
                        onClick={() => {
                          setEditando(f.id_proyecto);
                          setError(null);
                          setFormulario({
                            id_cliente: String(f.id_cliente),
                            nombre: f.nombre,
                            ubicacion: f.ubicacion ?? '',
                            tipo_proyecto: f.tipo_proyecto,
                            capacidad_kwp: f.capacidad_kwp === null ? '' : String(f.capacidad_kwp),
                            fecha_inicio: f.fecha_inicio?.slice(0, 10) ?? '',
                            observaciones: '',
                            activo: Boolean(f.activo),
                          });
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="boton boton--peligro boton--pequeno"
                        onClick={() => setAEliminar(f)}
                      >
                        Baja
                      </button>
                    </>
                  ) : null}
                </div>
              ),
            },
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_proyecto}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          ordenActual={listado.estado.orden}
          direccionActual={listado.estado.direccion}
          alOrdenar={listado.ordenar}
          vacioTitulo="No hay proyectos registrados"
          vacioDescripcion="Registre primero un cliente y luego su proyecto solar."
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>

      {formulario ? (
        <Modal titulo={editando ? 'Editar proyecto' : 'Nuevo proyecto solar'} alCerrar={() => setFormulario(null)}>
          {error ? <MensajeError error={error} /> : null}
          <MensajeInfo>
            La <strong>modalidad comercial</strong> corresponde a los valores PPA / EPC observados en los
            historicos. La <strong>potencia instalada se expresa en kWp</strong>; la energia generada se
            registra aparte en kWh.
          </MensajeInfo>
          <form onSubmit={guardar} noValidate>
            <div className="formulario">
              <CampoSelect
                etiqueta="Cliente propietario"
                obligatorio
                value={formulario.id_cliente}
                error={erroresCampo.id_cliente}
                ayuda="Un proyecto no puede existir sin cliente."
                onChange={(e) => setFormulario({ ...formulario, id_cliente: e.target.value })}
              >
                <option value="">Seleccione un cliente</option>
                {catalogos.clientes.map((c) => (
                  <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
                ))}
              </CampoSelect>
              <CampoTexto
                etiqueta="Nombre del proyecto (planta)"
                obligatorio
                value={formulario.nombre}
                error={erroresCampo.nombre}
                ayuda="Debe coincidir con la columna Planta de los archivos historicos."
                onChange={(e) => setFormulario({ ...formulario, nombre: e.target.value })}
              />
              <CampoSelect
                etiqueta="Modalidad comercial"
                value={formulario.tipo_proyecto}
                onChange={(e) => setFormulario({ ...formulario, tipo_proyecto: e.target.value })}
              >
                <option value="PPA">PPA</option>
                <option value="EPC">EPC</option>
                <option value="AUTOCONSUMO">Autoconsumo</option>
                <option value="OTRO">Otro</option>
              </CampoSelect>
              <CampoTexto
                etiqueta="Ubicacion"
                value={formulario.ubicacion}
                onChange={(e) => setFormulario({ ...formulario, ubicacion: e.target.value })}
              />
              <CampoTexto
                etiqueta="Potencia instalada (kWp)"
                type="number"
                min="0"
                step="0.001"
                value={formulario.capacidad_kwp}
                error={erroresCampo.capacidad_kwp}
                ayuda="Solo potencia. Nunca se registra aqui la generacion acumulada."
                onChange={(e) => setFormulario({ ...formulario, capacidad_kwp: e.target.value })}
              />
              <CampoTexto
                etiqueta="Fecha de inicio de operacion"
                type="date"
                value={formulario.fecha_inicio}
                onChange={(e) => setFormulario({ ...formulario, fecha_inicio: e.target.value })}
              />
              <CampoTexto
                etiqueta="Observaciones"
                ancho
                value={formulario.observaciones}
                onChange={(e) => setFormulario({ ...formulario, observaciones: e.target.value })}
              />
              <CampoCasilla
                etiqueta="Proyecto activo"
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
                {ocupado ? 'Guardando...' : 'Guardar proyecto'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {aEliminar ? (
        <Confirmacion
          titulo="Dar de baja el proyecto"
          peligroso
          ocupado={ocupado}
          textoConfirmar="Continuar"
          descripcion={
            <p>
              Si <strong>{aEliminar.nombre}</strong> tiene inversores o produccion registrada, el sistema lo
              desactivara en lugar de eliminarlo, para conservar el historico energetico y su auditoria.
            </p>
          }
          alConfirmar={eliminar}
          alCancelar={() => setAEliminar(null)}
        />
      ) : null}
    </>
  );
}
