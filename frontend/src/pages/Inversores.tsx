import { useEffect, useState, type FormEvent } from 'react';
import { Icono } from '../components/Iconos';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ErrorApi } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { useCatalogos, useGrupos } from '../hooks/useCatalogos';
import { CampoArea, CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import {
  Cargando,
  Confirmacion,
  MensajeError,
  MensajeExito,
  MensajeInfo,
  Modal,
} from '../components/Estados';
import { Paginacion, Tabla } from '../components/Tabla';
import { claseEstado, fecha, fechaHora, kwh, kwp, nombreMes, numero, quetzales, textoEstado } from '../lib/formato';

interface Inversor {
  id_inversor: number;
  id_proyecto: number;
  proyecto: string;
  /** Jerarquia PROYECTO -> GRUPO -> INVERSOR. */
  id_grupo: number;
  grupo: string;
  tiene_banco_baterias: number;
  cliente: string;
  marca: string;
  modelo: string;
  tipo_conexion: string;
  serial_externo: string | null;
  estacion_externa: string | null;
  capacidad_kwp: number | null;
  cantidad_paneles: number | null;
  potencia_panel_wp: number | null;
  capacidad_paneles_kwp: number | null;
  estado: string;
  id_api: number | null;
  observaciones: string | null;
  activo: number;
  ultima_actualizacion: string | null;
  kwh_total: number;
  ultima_produccion: string | null;
}

interface DetalleInversor extends Inversor {
  api_marca: string | null;
  api_modo: string | null;
  produccionMensual: Array<{ anio: number; mes: number; kwh: number; valor_q: number; pendientes: number }>;
  importaciones: Array<{
    id_historico: number;
    nombre_archivo_original: string;
    estado: string;
    total_filas: number;
    insertadas: number;
    rechazadas: number;
    created_at: string;
  }>;
  sincronizaciones: Array<{
    id_sync: number;
    tipo: string;
    modo: string;
    estado: string;
    rango_desde: string | null;
    rango_hasta: string | null;
    filas_recibidas: number;
    insertadas: number;
    codigo_error: string | null;
    mensaje: string | null;
    iniciada_en: string;
  }>;
}

const VACIO = {
  id_proyecto: '',
  id_grupo: '',
  marca: '',
  modelo: '',
  tipo_conexion: 'MANUAL',
  serial_externo: '',
  estacion_externa: '',
  capacidad_kwp: '',
  cantidad_paneles: '',
  potencia_panel_wp: '',
  estado: 'ACTIVO',
  observaciones: '',
  activo: true,
};

export function PaginaInversores() {
  const { puede } = useSesion();
  const catalogos = useCatalogos();
  const clienteConsultas = useQueryClient();
  const [parametros] = useSearchParams();

  const listado = useListado<Inversor>('inversores', '/inverters', { orden: 'proyecto' });

  useEffect(() => {
    const proyecto = parametros.get('proyecto');
    const grupo = parametros.get('id_grupo');
    if (proyecto) listado.actualizar({ id_proyecto: proyecto });
    if (grupo) listado.actualizar({ id_grupo: grupo });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parametros]);

  const [formulario, setFormulario] = useState<typeof VACIO | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [detalle, setDetalle] = useState<number | null>(null);

  // Los grupos dependen del proyecto: uno para el filtro y otro para el alta.
  const gruposDelFiltro = useGrupos(listado.estado.id_proyecto as string | undefined);
  const gruposDelFormulario = useGrupos(formulario?.id_proyecto);
  const [aEliminar, setAEliminar] = useState<Inversor | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const gestionar = puede('inversores.gestionar');

  const consultaDetalle = useQuery({
    queryKey: ['inversor', detalle],
    enabled: detalle !== null,
    queryFn: async () => (await api.obtener<DetalleInversor>(`/inverters/${detalle}`)).datos,
  });

  const refrescar = () => {
    listado.recargar();
    void clienteConsultas.invalidateQueries({ queryKey: ['catalogo', 'inversores'] });
  };

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!formulario) return;
    setOcupado(true);
    setError(null);
    try {
      const cuerpo = {
        ...formulario,
        id_proyecto: Number(formulario.id_proyecto),
        id_grupo: formulario.id_grupo === '' ? undefined : Number(formulario.id_grupo),
        capacidad_kwp: formulario.capacidad_kwp === '' ? null : Number(formulario.capacidad_kwp),
        cantidad_paneles: formulario.cantidad_paneles === '' ? null : Number(formulario.cantidad_paneles),
        potencia_panel_wp: formulario.potencia_panel_wp === '' ? null : Number(formulario.potencia_panel_wp),
        serial_externo: formulario.serial_externo || null,
        estacion_externa: formulario.estacion_externa || null,
        observaciones: formulario.observaciones || null,
      };
      if (editando) {
        await api.actualizar(`/inverters/${editando}`, cuerpo);
        setExito('Inversor actualizado correctamente.');
      } else {
        await api.crear('/inverters', cuerpo);
        setExito('Inversor creado correctamente.');
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
      const respuesta = await api.eliminar<{ mensaje: string }>(`/inverters/${aEliminar.id_inversor}`);
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
          <h1>Inversores</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Equipos que generan los registros de produccion. Los de tipo HUAWEI_API pueden sincronizarse
            automaticamente.
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
            <Icono nombre="mas" tamano={18} /> Nuevo inversor
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
            placeholder="Marca, modelo, serial o proyecto"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
          <CampoSelect
            etiqueta="Proyecto"
            value={String(listado.estado.id_proyecto ?? '')}
            onChange={(e) => listado.actualizar({ id_proyecto: e.target.value, id_grupo: '' })}
          >
            <option value="">Todos los proyectos</option>
            {catalogos.proyectos.map((p) => (
              <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Grupo de inversores"
            value={String(listado.estado.id_grupo ?? '')}
            disabled={!gruposDelFiltro.habilitado}
            ayuda={
              gruposDelFiltro.habilitado
                ? undefined
                : 'Seleccione primero un proyecto para filtrar por grupo.'
            }
            onChange={(e) => listado.actualizar({ id_grupo: e.target.value })}
          >
            <option value="">Todos los grupos</option>
            {gruposDelFiltro.grupos.map((g) => (
              <option key={g.id_grupo} value={g.id_grupo}>{g.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Tipo de conexion"
            value={String(listado.estado.tipo_conexion ?? '')}
            onChange={(e) => listado.actualizar({ tipo_conexion: e.target.value })}
          >
            <option value="">Todas</option>
            <option value="MANUAL">Manual</option>
            <option value="HUAWEI_API">Huawei SmartPVMS</option>
          </CampoSelect>
          <CampoSelect
            etiqueta="Estado"
            value={String(listado.estado.estado ?? '')}
            onChange={(e) => listado.actualizar({ estado: e.target.value })}
          >
            <option value="">Todos</option>
            <option value="ACTIVO">Activo</option>
            <option value="INACTIVO">Inactivo</option>
            <option value="MANTENIMIENTO">En mantenimiento</option>
          </CampoSelect>
        </div>

        <Tabla<Inversor>
          titulo="Listado de inversores"
          columnas={[
            {
              clave: 'equipo',
              titulo: 'Equipo',
              orden: 'marca',
              render: (f) => (
                <button
                  type="button"
                  style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--azul-700)', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => setDetalle(f.id_inversor)}
                >
                  {f.marca} {f.modelo}
                </button>
              ),
            },
            { clave: 'proyecto', titulo: 'Proyecto', orden: 'proyecto', render: (f) => f.proyecto },
            {
              clave: 'grupo',
              titulo: 'Grupo',
              render: (f) => (
                <span>
                  {f.grupo}
                  {f.tiene_banco_baterias ? (
                    <div>
                      <span className="etiqueta etiqueta--verde">Con baterias</span>
                    </div>
                  ) : null}
                </span>
              ),
            },
            { clave: 'serial', titulo: 'Identificador', render: (f) => f.serial_externo ?? '—' },
            {
              clave: 'conexion',
              titulo: 'Conexion',
              render: (f) => (
                <span className={f.tipo_conexion === 'HUAWEI_API' ? 'etiqueta etiqueta--azul' : 'etiqueta etiqueta--gris'}>
                  {textoEstado(f.tipo_conexion)}
                </span>
              ),
            },
            { clave: 'kwp', titulo: 'Potencia', numerica: true, render: (f) => kwp(f.capacidad_kwp) },
            {
              clave: 'paneles',
              titulo: 'Paneles',
              numerica: true,
              render: (f) =>
                f.cantidad_paneles ? (
                  <span title={`${f.cantidad_paneles} paneles de ${Number(f.potencia_panel_wp)} Wp`}>
                    {f.cantidad_paneles} × {Number(f.potencia_panel_wp)} Wp
                  </span>
                ) : (
                  <span style={{ color: 'var(--texto-suave)' }}>—</span>
                ),
            },
            { clave: 'kwh', titulo: 'Generacion acumulada', numerica: true, render: (f) => kwh(f.kwh_total) },
            {
              clave: 'estado',
              titulo: 'Estado',
              orden: 'estado',
              render: (f) => <span className={claseEstado(f.estado)}>{textoEstado(f.estado)}</span>,
            },
            {
              clave: 'ultima',
              titulo: 'Ultimo dato',
              orden: 'actualizacion',
              render: (f) => fecha(f.ultima_produccion),
            },
            {
              clave: 'acciones',
              titulo: 'Acciones',
              render: (f) => (
                <div className="acciones no-imprimir">
                  <button
                    type="button"
                    className="boton boton--secundario boton--pequeno"
                    onClick={() => setDetalle(f.id_inversor)}
                  >
                    Detalle
                  </button>
                  {gestionar ? (
                    <>
                      <button
                        type="button"
                        className="boton boton--secundario boton--pequeno"
                        onClick={() => {
                          setEditando(f.id_inversor);
                          setError(null);
                          setFormulario({
                            id_proyecto: String(f.id_proyecto),
                            id_grupo: String(f.id_grupo),
                            marca: f.marca,
                            modelo: f.modelo,
                            tipo_conexion: f.tipo_conexion,
                            serial_externo: f.serial_externo ?? '',
                            estacion_externa: f.estacion_externa ?? '',
                            capacidad_kwp: f.capacidad_kwp === null ? '' : String(f.capacidad_kwp),
                            cantidad_paneles: f.cantidad_paneles === null ? '' : String(f.cantidad_paneles),
                            potencia_panel_wp:
                              f.potencia_panel_wp === null ? '' : String(Number(f.potencia_panel_wp)),
                            estado: f.estado,
                            observaciones: f.observaciones ?? '',
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
          claveFila={(f) => f.id_inversor}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          ordenActual={listado.estado.orden}
          direccionActual={listado.estado.direccion}
          alOrdenar={listado.ordenar}
          vacioTitulo="No hay inversores registrados"
          vacioDescripcion="Registre un proyecto y luego sus inversores para poder cargar produccion por dispositivo."
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>

      {/* --------------------------- Formulario --------------------------- */}
      {formulario ? (
        <Modal titulo={editando ? 'Editar inversor' : 'Nuevo inversor'} alCerrar={() => setFormulario(null)}>
          {error ? <MensajeError error={error} /> : null}
          <form onSubmit={guardar} noValidate>
            <div className="formulario">
              <CampoSelect
                etiqueta="Proyecto"
                obligatorio
                value={formulario.id_proyecto}
                error={erroresCampo.id_proyecto}
                ayuda="Un inversor no puede existir sin proyecto."
                onChange={(e) =>
                  setFormulario({ ...formulario, id_proyecto: e.target.value, id_grupo: '' })
                }
              >
                <option value="">Seleccione un proyecto</option>
                {catalogos.proyectos.map((p) => (
                  <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
                ))}
              </CampoSelect>
              <CampoSelect
                etiqueta="Grupo de inversores"
                obligatorio
                value={formulario.id_grupo}
                error={erroresCampo.id_grupo}
                disabled={!gruposDelFormulario.habilitado}
                ayuda={
                  !gruposDelFormulario.habilitado
                    ? 'Seleccione primero el proyecto.'
                    : gruposDelFormulario.grupos.length === 0
                      ? 'Este proyecto aun no tiene grupos. Crealos desde el detalle del proyecto.'
                      : 'Todo inversor pertenece a un grupo dentro del proyecto.'
                }
                onChange={(e) => setFormulario({ ...formulario, id_grupo: e.target.value })}
              >
                <option value="">Seleccione un grupo</option>
                {gruposDelFormulario.grupos
                  .filter((g) => g.activo || String(g.id_grupo) === formulario.id_grupo)
                  .map((g) => (
                    <option key={g.id_grupo} value={g.id_grupo}>
                      {g.nombre}
                      {g.cantidad_inversores_declarada !== null
                        ? ` (${g.inversores_registrados} de ${g.cantidad_inversores_declarada})`
                        : ''}
                    </option>
                  ))}
              </CampoSelect>
              <CampoTexto
                etiqueta="Marca"
                obligatorio
                value={formulario.marca}
                error={erroresCampo.marca}
                onChange={(e) => setFormulario({ ...formulario, marca: e.target.value })}
              />
              <CampoTexto
                etiqueta="Modelo"
                obligatorio
                value={formulario.modelo}
                error={erroresCampo.modelo}
                onChange={(e) => setFormulario({ ...formulario, modelo: e.target.value })}
              />
              <CampoSelect
                etiqueta="Tipo de conexion"
                value={formulario.tipo_conexion}
                onChange={(e) => setFormulario({ ...formulario, tipo_conexion: e.target.value })}
              >
                <option value="MANUAL">Manual (carga de archivos)</option>
                <option value="HUAWEI_API">Huawei SmartPVMS (API autorizada)</option>
              </CampoSelect>
              <CampoTexto
                etiqueta="Identificador externo / serial"
                value={formulario.serial_externo}
                error={erroresCampo.serial_externo}
                obligatorio={formulario.tipo_conexion === 'HUAWEI_API'}
                ayuda="Obligatorio para inversores Huawei; permite emparejar los datos del fabricante."
                onChange={(e) => setFormulario({ ...formulario, serial_externo: e.target.value })}
              />
              {formulario.tipo_conexion === 'HUAWEI_API' ? (
                <CampoTexto
                  etiqueta="Codigo de estacion (stationCode)"
                  value={formulario.estacion_externa}
                  ayuda="Estacion de SmartPVMS a la que pertenece el dispositivo."
                  onChange={(e) => setFormulario({ ...formulario, estacion_externa: e.target.value })}
                />
              ) : null}
              <CampoTexto
                etiqueta="Capacidad (kWp)"
                type="number"
                min="0"
                step="0.001"
                value={formulario.capacidad_kwp}
                ayuda="Necesaria para comparar el rendimiento relativo entre inversores."
                onChange={(e) => setFormulario({ ...formulario, capacidad_kwp: e.target.value })}
              />
              <CampoTexto
                etiqueta="Cantidad de paneles instalados"
                type="number"
                min="1"
                step="1"
                value={formulario.cantidad_paneles}
                error={erroresCampo.cantidad_paneles}
                ayuda="Paneles que tiene conectados este inversor (todos de la misma potencia)."
                onChange={(e) => setFormulario({ ...formulario, cantidad_paneles: e.target.value })}
              />
              <CampoTexto
                etiqueta="Potencia de cada panel (Wp)"
                type="number"
                min="0"
                step="0.01"
                value={formulario.potencia_panel_wp}
                error={erroresCampo.potencia_panel_wp}
                ayuda={
                  formulario.cantidad_paneles && formulario.potencia_panel_wp
                    ? `Total del inversor: ${(
                        (Number(formulario.cantidad_paneles) * Number(formulario.potencia_panel_wp)) /
                        1000
                      ).toLocaleString('es-GT', { maximumFractionDigits: 3 })} kWp en paneles.`
                    : 'Vatios pico de cada panel, por ejemplo 550.'
                }
                onChange={(e) => setFormulario({ ...formulario, potencia_panel_wp: e.target.value })}
              />
              <CampoSelect
                etiqueta="Estado operativo"
                value={formulario.estado}
                onChange={(e) => setFormulario({ ...formulario, estado: e.target.value })}
              >
                <option value="ACTIVO">Activo</option>
                <option value="MANTENIMIENTO">En mantenimiento</option>
                <option value="INACTIVO">Inactivo</option>
              </CampoSelect>
              <CampoArea
                etiqueta="Observaciones"
                value={formulario.observaciones}
                onChange={(e) => setFormulario({ ...formulario, observaciones: e.target.value })}
              />
              <CampoCasilla
                etiqueta="Inversor activo en el sistema"
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
                {ocupado ? 'Guardando...' : 'Guardar inversor'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* --------------------------- Detalle --------------------------- */}
      {detalle !== null ? (
        <Modal titulo="Detalle del inversor" ancho alCerrar={() => setDetalle(null)}>
          {consultaDetalle.isLoading ? <Cargando /> : null}
          {consultaDetalle.error ? <MensajeError error={consultaDetalle.error} /> : null}
          {consultaDetalle.data ? (
            <>
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 1rem', fontSize: '0.88rem' }}>
                <dt style={{ fontWeight: 640 }}>Equipo</dt>
                <dd style={{ margin: 0 }}>
                  {consultaDetalle.data.marca} {consultaDetalle.data.modelo}
                </dd>
                <dt style={{ fontWeight: 640 }}>Proyecto</dt>
                <dd style={{ margin: 0 }}>
                  {consultaDetalle.data.proyecto} ({consultaDetalle.data.cliente})
                </dd>
                <dt style={{ fontWeight: 640 }}>Identificador</dt>
                <dd style={{ margin: 0 }}>{consultaDetalle.data.serial_externo ?? 'No registrado'}</dd>
                <dt style={{ fontWeight: 640 }}>Potencia instalada</dt>
                <dd style={{ margin: 0 }}>{kwp(consultaDetalle.data.capacidad_kwp)}</dd>
                <dt style={{ fontWeight: 640 }}>Paneles instalados</dt>
                <dd style={{ margin: 0 }}>
                  {consultaDetalle.data.cantidad_paneles
                    ? `${consultaDetalle.data.cantidad_paneles} paneles de ${Number(consultaDetalle.data.potencia_panel_wp)} Wp`
                    : 'No registrados'}
                </dd>
                <dt style={{ fontWeight: 640 }}>Integracion</dt>
                <dd style={{ margin: 0 }}>
                  {consultaDetalle.data.api_marca
                    ? `${consultaDetalle.data.api_marca} (${textoEstado(consultaDetalle.data.api_modo)})`
                    : 'Sin integracion asociada'}
                </dd>
                <dt style={{ fontWeight: 640 }}>Ultimo dato disponible</dt>
                <dd style={{ margin: 0 }}>{fecha(consultaDetalle.data.ultima_actualizacion)}</dd>
                <dt style={{ fontWeight: 640 }}>Observaciones</dt>
                <dd style={{ margin: 0 }}>{consultaDetalle.data.observaciones ?? '—'}</dd>
              </dl>

              <h3 style={{ marginTop: '1.2rem' }}>Produccion mensual (ultimos 24 meses)</h3>
              <Tabla
                columnas={[
                  { clave: 'periodo', titulo: 'Periodo', render: (f) => `${nombreMes(f.mes)} ${f.anio}` },
                  { clave: 'kwh', titulo: 'Generacion', numerica: true, render: (f) => kwh(f.kwh) },
                  { clave: 'valor', titulo: 'Valor', numerica: true, render: (f) => quetzales(f.valor_q) },
                  {
                    clave: 'pend',
                    titulo: 'Sin valorizar',
                    numerica: true,
                    render: (f) =>
                      Number(f.pendientes) > 0 ? (
                        <span className="etiqueta etiqueta--ambar">{numero(f.pendientes, 0)}</span>
                      ) : (
                        '0'
                      ),
                  },
                ]}
                filas={consultaDetalle.data.produccionMensual}
                claveFila={(f) => `${f.anio}-${f.mes}`}
                vacioTitulo="Este inversor aun no tiene produccion registrada"
              />

              <h3 style={{ marginTop: '1.2rem' }}>Importaciones asociadas</h3>
              <Tabla
                columnas={[
                  { clave: 'archivo', titulo: 'Archivo', render: (f) => f.nombre_archivo_original },
                  {
                    clave: 'estado',
                    titulo: 'Estado',
                    render: (f) => <span className={claseEstado(f.estado)}>{textoEstado(f.estado)}</span>,
                  },
                  { clave: 'filas', titulo: 'Insertadas', numerica: true, render: (f) => `${f.insertadas}/${f.total_filas}` },
                  { clave: 'fecha', titulo: 'Fecha', render: (f) => fechaHora(f.created_at) },
                ]}
                filas={consultaDetalle.data.importaciones}
                claveFila={(f) => f.id_historico}
                vacioTitulo="Sin importaciones asociadas"
              />

              <h3 style={{ marginTop: '1.2rem' }}>Sincronizaciones</h3>
              <Tabla
                columnas={[
                  {
                    clave: 'estado',
                    titulo: 'Estado',
                    render: (f) => (
                      <>
                        <span className={claseEstado(f.estado)}>{textoEstado(f.estado)}</span>{' '}
                        {f.modo === 'MOCK' ? <span className="etiqueta etiqueta--azul">Simulado</span> : null}
                      </>
                    ),
                  },
                  {
                    clave: 'rango',
                    titulo: 'Rango',
                    render: (f) => `${fecha(f.rango_desde)} – ${fecha(f.rango_hasta)}`,
                  },
                  { clave: 'filas', titulo: 'Insertadas', numerica: true, render: (f) => `${f.insertadas}/${f.filas_recibidas}` },
                  { clave: 'mensaje', titulo: 'Resultado', render: (f) => f.codigo_error ?? f.mensaje ?? '—' },
                  { clave: 'fecha', titulo: 'Fecha', render: (f) => fechaHora(f.iniciada_en) },
                ]}
                filas={consultaDetalle.data.sincronizaciones}
                claveFila={(f) => f.id_sync}
                vacioTitulo="Sin sincronizaciones registradas"
              />
            </>
          ) : null}
        </Modal>
      ) : null}

      {aEliminar ? (
        <Confirmacion
          titulo="Dar de baja el inversor"
          peligroso
          ocupado={ocupado}
          textoConfirmar="Continuar"
          descripcion={
            <p>
              Si <strong>{aEliminar.marca} {aEliminar.modelo}</strong> tiene produccion registrada, el sistema
              lo desactivara en lugar de eliminarlo para conservar el historico.
            </p>
          }
          alConfirmar={eliminar}
          alCancelar={() => setAEliminar(null)}
        />
      ) : null}

      <MensajeInfo>
        La potencia instalada (kWp) es opcional, pero sin ella el inversor no puede incluirse en las
        comparaciones de rendimiento relativo, porque no existiria una base comparable.
      </MensajeInfo>
    </>
  );
}
