import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ErrorApi } from '../lib/api';
import { useSesion } from '../lib/auth';
import { CampoArea, CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import {
  Cargando,
  Confirmacion,
  MensajeAlerta,
  MensajeError,
  MensajeExito,
  MensajeInfo,
  Modal,
  SinPermiso,
} from '../components/Estados';
import { Tabla } from '../components/Tabla';
import {
  anioActual,
  claseEstado,
  fecha,
  fechaHora,
  kwh,
  kwp,
  nombreMes,
  numero,
  porcentaje,
  quetzales,
  tarifa as formatoTarifa,
  textoEstado,
} from '../lib/formato';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface DetalleProyecto {
  id_proyecto: number;
  nombre: string;
  cliente: string;
  cliente_nit: string;
  ubicacion: string | null;
  tipo_proyecto: string;
  capacidad_kwp: number | null;
  fecha_inicio: string | null;
  observaciones: string | null;
  activo: number;
  inversores: Array<{
    id_inversor: number;
    marca: string;
    modelo: string;
    serial_externo: string | null;
    tipo_conexion: string;
    estado: string;
    capacidad_kwp: number | null;
    ultima_produccion: string | null;
  }>;
  resumen: {
    kwh_total: number;
    valor_total: number;
    registros_pendientes: number;
    primera_fecha: string | null;
    ultima_fecha: string | null;
  } | null;
  // El proyecto nunca captura sus paneles por separado: siempre es la suma
  // de los lotes de todos sus grupos (ver PanelGrupos / ModalPaneles).
  panelesProyecto: {
    cantidadPaneles: number;
    capacidadPanelesKwp: number;
  };
}

interface TarifaTrimestre {
  id_tarifa: number;
  trimestre: number;
  costo_kwh: number;
  moneda: string;
  estado: string;
  origen: string;
  creado_por_nombre: string | null;
  aprobado_por_nombre: string | null;
  fecha_creacion: string;
  fecha_aprobacion: string | null;
  updated_at: string;
}

interface FilaCalendarioTarifa {
  trimestre: number;
  /** "I trimestre", "II trimestre"... */
  etiqueta: string;
  /** "Enero a Marzo" */
  meses: string;
  mesesNumeros: number[];
  mesesNombres: string[];
  tarifa: TarifaTrimestre | null;
  /** El cierre contable sigue siendo mensual. */
  mesesCerrados: number[];
  cerradoParcial: boolean;
  cerradoCompleto: boolean;
  registrosProduccion: number;
  registrosPendientes: number;
  kwh: number;
  requiereAtencion: boolean;
}

/** Aviso de que toca actualizar la tarifa del kWh de este trimestre. */
interface AlertaTrimestral {
  trimestreActual: { anio: number; trimestre: number; etiqueta: string };
  trimestreSiguiente: { anio: number; trimestre: number; etiqueta: string };
  diasRestantes: number;
  diasDeAviso: number;
  proyectosSinTarifaActual: Array<{ id_proyecto: number; proyecto: string }>;
  proyectosSinTarifaSiguiente: Array<{ id_proyecto: number; proyecto: string }>;
  requiereAtencion: boolean;
  mensaje: string | null;
}

interface RespuestaTarifas {
  anio: number;
  id_proyecto: number;
  periodicidad: 'TRIMESTRAL';
  calendario: FilaCalendarioTarifa[];
  alerta: AlertaTrimestral;
  resumen: {
    trimestresAprobados: number;
    trimestresBorrador: number;
    trimestresSinTarifa: number;
    trimestresConProduccionSinTarifa: number;
  };
}

interface ProyeccionMes {
  id_proyeccion: number;
  mes: number;
  proyeccion_kwh: number;
  estado: string;
  origen: string;
  comentarios: string | null;
  creado_por_nombre: string | null;
  aprobado_por_nombre: string | null;
  updated_at: string;
}

interface RespuestaProyecciones {
  anio: number;
  calendario: Array<{
    mes: number;
    mesNombre: string;
    proyeccion: ProyeccionMes | null;
    generacion_kwh: number;
    cumplimiento: number | null;
    etiquetaCumplimiento: string | null;
  }>;
  totales: {
    proyeccion_kwh: number;
    generacion_kwh: number;
    cumplimiento: number | null;
    mesesAprobados: number;
    mesesSinProyeccion: number;
  };
}

interface Impacto {
  id_tarifa: number;
  anio: number;
  trimestre: number;
  etiqueta: string;
  mesesCerrados: number[];
  costoActual: number;
  costoPropuesto: number;
  registrosAfectados: number;
  kwhAfectados: number;
  valorAnterior: number;
  valorNuevo: number;
  diferencia: number;
  advertencia: string;
}

// --- Etiquetas de los trimestres, en el mismo orden que usa el servidor ----
const ROMANOS = ['I', 'II', 'III', 'IV'];

function etiquetaTrimestre(trimestre: number): string {
  return `${ROMANOS[trimestre - 1] ?? trimestre} trimestre`;
}

function mesesDelTrimestre(trimestre: number): string {
  const primero = (trimestre - 1) * 3 + 1;
  return `${nombreMes(primero)} a ${nombreMes(primero + 2)}`;
}

/** Grupo de inversores: nivel intermedio entre el proyecto y el equipo. */
interface Grupo {
  id_grupo: number;
  nombre: string;
  cantidad_inversores_declarada: number | null;
  inversores_registrados: number;
  inversoresFaltantes: number;
  avisoInversores: string | null;
  tiene_banco_baterias: number;
  capacidad_baterias_kwh: number | null;
  capacidad_kwp: number | null;
  // Calculados sumando los lotes de paneles activos del grupo (ver abajo).
  cantidad_paneles: number;
  capacidad_paneles_kwp: number;
  ubicacion: string | null;
  observaciones: string | null;
  activo: number;
  kwh_total: number;
  ultima_produccion: string | null;
}

interface TotalesGrupos {
  grupos: number;
  inversoresRegistrados: number;
  inversoresDeclarados: number;
  gruposConBaterias: number;
  capacidadBateriasKwh: number;
  cantidadPaneles: number;
  capacidadPanelesKwp: number;
}

/** Lote de paneles de un grupo: cantidad de paneles con la misma potencia. */
interface LotePaneles {
  id_lote: number;
  id_grupo: number;
  cantidad: number;
  potencia_wp: number;
  marca: string | null;
  modelo: string | null;
  fecha_instalacion: string | null;
  observaciones: string | null;
}

type Pestana = 'resumen' | 'grupos' | 'tarifas' | 'proyecciones';

// ---------------------------------------------------------------------------
// Pagina
// ---------------------------------------------------------------------------

export function PaginaProyectoDetalle() {
  const { id } = useParams();
  const idProyecto = Number(id);
  const { puede } = useSesion();
  const [pestana, setPestana] = useState<Pestana>('resumen');

  const proyecto = useQuery({
    queryKey: ['proyecto', idProyecto],
    queryFn: async () => (await api.obtener<DetalleProyecto>(`/projects/${idProyecto}`)).datos,
  });

  if (proyecto.isLoading) return <Cargando />;
  if (proyecto.error) return <MensajeError error={proyecto.error} alReintentar={() => void proyecto.refetch()} />;
  if (!proyecto.data) return null;

  const p = proyecto.data;

  return (
    <>
      <div className="barra-superior">
        <div>
          <p style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>
            <Link to="/proyectos">Proyectos</Link> · {p.cliente}
          </p>
          <h1>{p.nombre}</h1>
          <div className="acciones" style={{ marginTop: '0.35rem' }}>
            <span className="etiqueta etiqueta--azul">{p.tipo_proyecto}</span>
            <span className={p.activo ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--gris'}>
              {p.activo ? 'Activo' : 'Inactivo'}
            </span>
            <span style={{ fontSize: '0.83rem', color: 'var(--texto-suave)' }}>
              {p.ubicacion ?? 'Sin ubicacion'} · {kwp(p.capacidad_kwp)}
            </span>
          </div>
        </div>
      </div>

      <nav className="no-imprimir" aria-label="Secciones del proyecto">
        <ul className="pasos" style={{ marginBottom: '1rem' }}>
          {([
            ['resumen', 'Resumen e inversores'],
            ['grupos', 'Grupos de inversores'],
            ['tarifas', 'Tarifas de energia'],
            ['proyecciones', 'Proyecciones mensuales'],
          ] as Array<[Pestana, string]>).map(([clave, texto]) => (
            <li key={clave} aria-current={pestana === clave ? 'step' : undefined}>
              <button
                type="button"
                onClick={() => setPestana(clave)}
                style={{
                  background: 'none',
                  border: 0,
                  font: 'inherit',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                {texto}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {pestana === 'resumen' ? <Resumen proyecto={p} /> : null}
      {pestana === 'grupos' ? <PanelGrupos idProyecto={idProyecto} /> : null}
      {pestana === 'tarifas' ? (
        puede('tarifas.ver') ? <PanelTarifas idProyecto={idProyecto} /> : <SinPermiso permiso="tarifas.ver" />
      ) : null}
      {pestana === 'proyecciones' ? (
        puede('proyecciones.ver') ? (
          <PanelProyecciones idProyecto={idProyecto} />
        ) : (
          <SinPermiso permiso="proyecciones.ver" />
        )
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

function Resumen({ proyecto }: { proyecto: DetalleProyecto }) {
  const r = proyecto.resumen;
  return (
    <>
      <section className="rejilla">
        <div className="indicador">
          <p className="indicador__etiqueta">Produccion acumulada</p>
          <p className="indicador__valor">{kwh(r?.kwh_total ?? 0)}</p>
          <p className="indicador__detalle">
            {fecha(r?.primera_fecha)} – {fecha(r?.ultima_fecha)}
          </p>
        </div>
        <div className={Number(r?.registros_pendientes ?? 0) > 0 ? 'indicador indicador--ambar' : 'indicador indicador--verde'}>
          <p className="indicador__etiqueta">Valor acumulado</p>
          <p className="indicador__valor">{quetzales(r?.valor_total ?? 0)}</p>
          <p className="indicador__detalle">
            {Number(r?.registros_pendientes ?? 0) > 0
              ? `${r?.registros_pendientes} registro(s) pendiente(s) de tarifa`
              : 'Todos los registros valorizados'}
          </p>
        </div>
        <div className="indicador">
          <p className="indicador__etiqueta">Potencia instalada</p>
          <p className="indicador__valor">{kwp(proyecto.capacidad_kwp)}</p>
          <p className="indicador__detalle">{proyecto.inversores.length} inversor(es) registrados</p>
        </div>
        <div className="indicador">
          <p className="indicador__etiqueta">Paneles instalados</p>
          <p className="indicador__valor">{numero(proyecto.panelesProyecto.cantidadPaneles, 0)}</p>
          <p className="indicador__detalle">
            {kwp(proyecto.panelesProyecto.capacidadPanelesKwp)} entre todos los grupos
          </p>
        </div>
        <div className="indicador">
          <p className="indicador__etiqueta">Cliente</p>
          <p className="indicador__valor" style={{ fontSize: '1.05rem' }}>{proyecto.cliente}</p>
          <p className="indicador__detalle">NIT {proyecto.cliente_nit}</p>
        </div>
      </section>

      <section className="tarjeta">
        <h2>Inversores del proyecto</h2>
        <Tabla
          columnas={[
            {
              clave: 'equipo',
              titulo: 'Equipo',
              render: (f) => (
                <Link to={`/inversores?proyecto=${proyecto.id_proyecto}`}>
                  {f.marca} {f.modelo}
                </Link>
              ),
            },
            { clave: 'serial', titulo: 'Identificador externo', render: (f) => f.serial_externo ?? '—' },
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
              clave: 'estado',
              titulo: 'Estado',
              render: (f) => <span className={claseEstado(f.estado)}>{textoEstado(f.estado)}</span>,
            },
            { clave: 'ultima', titulo: 'Ultimo dato', render: (f) => fecha(f.ultima_produccion) },
          ]}
          filas={proyecto.inversores}
          claveFila={(f) => f.id_inversor}
          vacioTitulo="Este proyecto no tiene inversores registrados"
          vacioDescripcion="La produccion puede cargarse como consolidado del proyecto, pero se recomienda registrar los inversores."
        />
      </section>

      {proyecto.observaciones ? (
        <section className="tarjeta">
          <h2>Observaciones</h2>
          <p>{proyecto.observaciones}</p>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Grupos de inversores
//
// Jerarquia del sistema:  PROYECTO -> GRUPO -> INVERSOR
// Un proyecto tiene varios grupos y cada grupo agrupa varios inversores con
// sus seriales. El grupo declara cuantos equipos deberia tener y si cuenta con
// banco de baterias, y es la unidad sobre la que se carga produccion manual
// cuando falla la conexion con el fabricante.
// ---------------------------------------------------------------------------

const GRUPO_FORMULARIO = {
  nombre: '',
  cantidad_inversores_declarada: '',
  tiene_banco_baterias: false,
  capacidad_baterias_kwh: '',
  capacidad_kwp: '',
  ubicacion: '',
  observaciones: '',
  activo: true,
};

function PanelGrupos({ idProyecto }: { idProyecto: number }) {
  const { puede } = useSesion();
  const clienteConsultas = useQueryClient();
  const [formulario, setFormulario] = useState<typeof GRUPO_FORMULARIO | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [aEliminar, setAEliminar] = useState<Grupo | null>(null);
  const [gestionandoPaneles, setGestionandoPaneles] = useState<Grupo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const gestionar = puede('inversores.gestionar');

  const consulta = useQuery({
    queryKey: ['grupos', idProyecto],
    queryFn: async () => {
      const respuesta = await api.obtener<Grupo[]>(`/projects/${idProyecto}/groups`);
      return {
        grupos: respuesta.datos,
        totales: (respuesta.meta?.totales ?? null) as TotalesGrupos | null,
      };
    },
  });

  const refrescar = () => {
    void consulta.refetch();
    void clienteConsultas.invalidateQueries({ queryKey: ['proyecto', idProyecto] });
    void clienteConsultas.invalidateQueries({ queryKey: ['catalogo', 'grupos'] });
  };

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!formulario) return;
    setOcupado(true);
    setError(null);
    try {
      const cuerpo = {
        nombre: formulario.nombre,
        cantidad_inversores_declarada:
          formulario.cantidad_inversores_declarada === ''
            ? null
            : Number(formulario.cantidad_inversores_declarada),
        tiene_banco_baterias: formulario.tiene_banco_baterias,
        capacidad_baterias_kwh:
          formulario.capacidad_baterias_kwh === '' ? null : Number(formulario.capacidad_baterias_kwh),
        capacidad_kwp: formulario.capacidad_kwp === '' ? null : Number(formulario.capacidad_kwp),
        ubicacion: formulario.ubicacion || null,
        observaciones: formulario.observaciones || null,
        activo: formulario.activo,
      };
      const respuesta = editando
        ? await api.actualizar<{ mensaje: string }>(`/projects/${idProyecto}/groups/${editando}`, cuerpo)
        : await api.crear<{ mensaje: string }>(`/projects/${idProyecto}/groups`, cuerpo);
      setExito(respuesta.datos.mensaje);
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
      const respuesta = await api.eliminar<{ mensaje: string }>(
        `/projects/${idProyecto}/groups/${aEliminar.id_grupo}`,
      );
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
  const grupos = consulta.data?.grupos ?? [];
  const totales = consulta.data?.totales ?? null;
  const conAviso = grupos.filter((g) => g.avisoInversores !== null);

  return (
    <>
      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error && !formulario ? <MensajeError error={error} /> : null}

      <section className="tarjeta">
        <div className="tarjeta__titulo">
          <h2>Grupos de inversores</h2>
          {gestionar ? (
            <button
              type="button"
              className="boton no-imprimir"
              onClick={() => {
                setEditando(null);
                setError(null);
                setFormulario({ ...GRUPO_FORMULARIO });
              }}
            >
              Nuevo grupo
            </button>
          ) : null}
        </div>

        <MensajeInfo>
          Cada proyecto se organiza en <strong>grupos</strong> y cada grupo agrupa varios{' '}
          <strong>inversores</strong> con sus seriales. El grupo declara cuantos equipos deberia tener y
          si cuenta con banco de baterias. Ademas es la unidad sobre la que se puede{' '}
          <strong>cargar produccion manualmente</strong> cuando el fabricante no entrega datos.
        </MensajeInfo>

        {conAviso.length > 0 ? (
          <MensajeAlerta titulo="Hay grupos con equipo pendiente de registrar">
            <ul style={{ margin: '0.3rem 0 0 1rem' }}>
              {conAviso.map((g) => (
                <li key={g.id_grupo}>
                  <strong>{g.nombre}</strong>: {g.avisoInversores}
                </li>
              ))}
            </ul>
          </MensajeAlerta>
        ) : null}

        {totales ? (
          <section className="rejilla">
            <div className="indicador">
              <p className="indicador__etiqueta">Grupos</p>
              <p className="indicador__valor">{totales.grupos}</p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Inversores registrados</p>
              <p className="indicador__valor">{totales.inversoresRegistrados}</p>
              <p className="indicador__detalle">
                de {totales.inversoresDeclarados} declarado(s)
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Grupos con banco de baterias</p>
              <p className="indicador__valor">{totales.gruposConBaterias}</p>
              <p className="indicador__detalle">{kwh(totales.capacidadBateriasKwh)} de capacidad</p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Paneles instalados</p>
              <p className="indicador__valor">{numero(totales.cantidadPaneles, 0)}</p>
              <p className="indicador__detalle">{kwp(totales.capacidadPanelesKwp)} en total</p>
            </div>
          </section>
        ) : null}

        <Tabla<Grupo>
          titulo="Listado de grupos"
          descripcion="Un grupo con inversores o produccion asociada se desactiva en lugar de eliminarse."
          columnas={[
            { clave: 'nombre', titulo: 'Grupo', render: (g) => g.nombre },
            {
              clave: 'inversores',
              titulo: 'Inversores',
              numerica: true,
              render: (g) => (
                <span>
                  {g.inversores_registrados}
                  {g.cantidad_inversores_declarada !== null
                    ? ` de ${g.cantidad_inversores_declarada}`
                    : ''}
                  {g.inversoresFaltantes > 0 ? (
                    <div>
                      <span className="etiqueta etiqueta--ambar">
                        faltan {g.inversoresFaltantes}
                      </span>
                    </div>
                  ) : null}
                </span>
              ),
            },
            {
              clave: 'baterias',
              titulo: 'Banco de baterias',
              render: (g) =>
                g.tiene_banco_baterias ? (
                  <span className="etiqueta etiqueta--verde">
                    Si · {kwh(g.capacidad_baterias_kwh ?? 0)}
                  </span>
                ) : (
                  <span className="etiqueta etiqueta--gris">No</span>
                ),
            },
            { clave: 'kwp', titulo: 'Potencia', numerica: true, render: (g) => kwp(g.capacidad_kwp) },
            {
              clave: 'paneles',
              titulo: 'Paneles',
              numerica: true,
              render: (g) =>
                g.cantidad_paneles > 0 ? (
                  <span>
                    {numero(g.cantidad_paneles, 0)}
                    <div style={{ fontSize: '0.75rem', color: 'var(--texto-suave)' }}>
                      {kwp(g.capacidad_paneles_kwp)}
                    </div>
                  </span>
                ) : (
                  <span style={{ color: 'var(--texto-suave)' }}>Sin registrar</span>
                ),
            },
            { clave: 'ubicacion', titulo: 'Ubicacion', render: (g) => g.ubicacion ?? '—' },
            {
              clave: 'produccion',
              titulo: 'Produccion acumulada',
              numerica: true,
              render: (g) => kwh(g.kwh_total),
            },
            { clave: 'ultima', titulo: 'Ultimo dato', render: (g) => fecha(g.ultima_produccion) },
            {
              clave: 'estado',
              titulo: 'Estado',
              render: (g) => (
                <span className={g.activo ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--gris'}>
                  {g.activo ? 'Activo' : 'Inactivo'}
                </span>
              ),
            },
            {
              clave: 'acciones',
              titulo: 'Acciones',
              render: (g) => (
                <div className="acciones no-imprimir">
                  <Link
                    className="boton boton--secundario boton--pequeno"
                    to={`/inversores?id_grupo=${g.id_grupo}`}
                  >
                    Ver inversores
                  </Link>
                  <button
                    type="button"
                    className="boton boton--secundario boton--pequeno"
                    onClick={() => setGestionandoPaneles(g)}
                  >
                    Paneles
                  </button>
                  {gestionar ? (
                    <>
                      <button
                        type="button"
                        className="boton boton--secundario boton--pequeno"
                        onClick={() => {
                          setEditando(g.id_grupo);
                          setError(null);
                          setFormulario({
                            nombre: g.nombre,
                            cantidad_inversores_declarada:
                              g.cantidad_inversores_declarada === null
                                ? ''
                                : String(g.cantidad_inversores_declarada),
                            tiene_banco_baterias: Boolean(g.tiene_banco_baterias),
                            capacidad_baterias_kwh:
                              g.capacidad_baterias_kwh === null ? '' : String(g.capacidad_baterias_kwh),
                            capacidad_kwp: g.capacidad_kwp === null ? '' : String(g.capacidad_kwp),
                            ubicacion: g.ubicacion ?? '',
                            observaciones: g.observaciones ?? '',
                            activo: Boolean(g.activo),
                          });
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="boton boton--peligro boton--pequeno"
                        onClick={() => setAEliminar(g)}
                      >
                        Baja
                      </button>
                    </>
                  ) : null}
                </div>
              ),
            },
          ]}
          filas={grupos}
          claveFila={(g) => g.id_grupo}
          cargando={consulta.isLoading}
          error={consulta.error}
          alReintentar={() => void consulta.refetch()}
          vacioTitulo="Este proyecto aun no tiene grupos"
          vacioDescripcion="Cree al menos un grupo antes de registrar los inversores del proyecto."
        />
      </section>

      {formulario ? (
        <Modal
          titulo={editando ? 'Editar grupo de inversores' : 'Nuevo grupo de inversores'}
          alCerrar={() => setFormulario(null)}
        >
          {error ? <MensajeError error={error} /> : null}
          <form onSubmit={guardar} noValidate>
            <div className="formulario">
              <CampoTexto
                etiqueta="Nombre del grupo"
                obligatorio
                placeholder="Ej. Bloque A - Campo norte"
                value={formulario.nombre}
                error={erroresCampo.nombre}
                onChange={(e) => setFormulario({ ...formulario, nombre: e.target.value })}
              />
              <CampoTexto
                etiqueta="Cantidad de inversores del grupo"
                type="number"
                min="0"
                step="1"
                value={formulario.cantidad_inversores_declarada}
                error={erroresCampo.cantidad_inversores_declarada}
                ayuda="Cuantos equipos lleva el grupo. El sistema avisa si faltan por registrar."
                onChange={(e) =>
                  setFormulario({ ...formulario, cantidad_inversores_declarada: e.target.value })
                }
              />
              <CampoTexto
                etiqueta="Potencia del grupo (kWp)"
                type="number"
                min="0"
                step="0.001"
                value={formulario.capacidad_kwp}
                onChange={(e) => setFormulario({ ...formulario, capacidad_kwp: e.target.value })}
              />
              <CampoTexto
                etiqueta="Ubicacion"
                value={formulario.ubicacion}
                onChange={(e) => setFormulario({ ...formulario, ubicacion: e.target.value })}
              />
              <CampoCasilla
                etiqueta="Cuenta con banco de baterias"
                checked={formulario.tiene_banco_baterias}
                onChange={(e) =>
                  setFormulario({
                    ...formulario,
                    tiene_banco_baterias: e.target.checked,
                    capacidad_baterias_kwh: e.target.checked ? formulario.capacidad_baterias_kwh : '',
                  })
                }
              />
              <CampoTexto
                etiqueta="Capacidad del banco (kWh)"
                type="number"
                min="0"
                step="0.01"
                disabled={!formulario.tiene_banco_baterias}
                value={formulario.capacidad_baterias_kwh}
                error={erroresCampo.capacidad_baterias_kwh}
                ayuda="Solo aplica si el grupo tiene banco de baterias."
                onChange={(e) =>
                  setFormulario({ ...formulario, capacidad_baterias_kwh: e.target.value })
                }
              />
              <CampoArea
                etiqueta="Observaciones"
                value={formulario.observaciones}
                onChange={(e) => setFormulario({ ...formulario, observaciones: e.target.value })}
              />
              <CampoCasilla
                etiqueta="Grupo activo"
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
                {ocupado ? 'Guardando...' : 'Guardar grupo'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {aEliminar ? (
        <Confirmacion
          titulo="Dar de baja el grupo"
          peligroso
          ocupado={ocupado}
          textoConfirmar="Continuar"
          descripcion={
            <p>
              Si <strong>{aEliminar.nombre}</strong> tiene inversores o produccion registrada, el sistema
              lo desactivara en lugar de eliminarlo, para conservar el historico energetico.
            </p>
          }
          alConfirmar={eliminar}
          alCancelar={() => setAEliminar(null)}
        />
      ) : null}

      {gestionandoPaneles ? (
        <ModalPaneles
          idProyecto={idProyecto}
          grupo={gestionandoPaneles}
          gestionar={gestionar}
          alCerrar={() => setGestionandoPaneles(null)}
          alCambiar={refrescar}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Lotes de paneles de un grupo
//
// Una instalacion con varios anios de operacion suele tener paneles de
// distinta generacion en el MISMO grupo (ej. paneles originales de menor
// potencia mas una ampliacion posterior con paneles mas potentes, mismas
// dimensiones fisicas). Cada lote registra una cantidad de paneles con su
// propia potencia unitaria; el total del grupo (y, sumando grupos, el del
// proyecto) se calcula solo, sin que el operador tenga que recalcularlo.
// ---------------------------------------------------------------------------

const LOTE_FORMULARIO = {
  cantidad: '',
  potencia_wp: '',
  marca: '',
  modelo: '',
  fecha_instalacion: '',
  observaciones: '',
};

function ModalPaneles({
  idProyecto,
  grupo,
  gestionar,
  alCerrar,
  alCambiar,
}: {
  idProyecto: number;
  grupo: Grupo;
  gestionar: boolean;
  alCerrar: () => void;
  alCambiar: () => void;
}) {
  const [formulario, setFormulario] = useState<typeof LOTE_FORMULARIO | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [aRetirar, setARetirar] = useState<LotePaneles | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const consulta = useQuery({
    queryKey: ['paneles', grupo.id_grupo],
    queryFn: async () => {
      const respuesta = await api.obtener<LotePaneles[]>(
        `/projects/${idProyecto}/groups/${grupo.id_grupo}/panels`,
      );
      return respuesta.datos;
    },
  });

  const lotes = consulta.data ?? [];
  const totalCantidad = lotes.reduce((a, l) => a + Number(l.cantidad), 0);
  const totalKwp = lotes.reduce((a, l) => a + (Number(l.cantidad) * Number(l.potencia_wp)) / 1000, 0);
  const erroresCampo = error instanceof ErrorApi ? error.erroresPorCampo : {};

  const refrescar = () => {
    void consulta.refetch();
    alCambiar();
  };

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!formulario) return;
    setOcupado(true);
    setError(null);
    try {
      const cuerpo = {
        cantidad: Number(formulario.cantidad),
        potencia_wp: Number(formulario.potencia_wp),
        marca: formulario.marca || null,
        modelo: formulario.modelo || null,
        fecha_instalacion: formulario.fecha_instalacion || null,
        observaciones: formulario.observaciones || null,
      };
      const ruta = `/projects/${idProyecto}/groups/${grupo.id_grupo}/panels`;
      if (editando) {
        await api.actualizar<{ mensaje: string }>(`${ruta}/${editando}`, cuerpo);
      } else {
        await api.crear<{ mensaje: string }>(ruta, cuerpo);
      }
      setFormulario(null);
      setEditando(null);
      refrescar();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const retirar = async () => {
    if (!aRetirar) return;
    setOcupado(true);
    try {
      await api.eliminar(
        `/projects/${idProyecto}/groups/${grupo.id_grupo}/panels/${aRetirar.id_lote}`,
      );
      setARetirar(null);
      refrescar();
    } catch (fallo) {
      setError(fallo);
      setARetirar(null);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal titulo={`Paneles de ${grupo.nombre}`} alCerrar={alCerrar} ancho>
      {error ? <MensajeError error={error} /> : null}

      <MensajeInfo titulo="Por que se registran por lotes">
        Un grupo puede tener paneles de distintas generaciones -- por ejemplo, paneles originales de
        menor potencia y, tras una ampliacion, paneles nuevos de mayor potencia con las mismas
        dimensiones. Registre cada lote por separado (cantidad y potencia unitaria en Wp): el total de
        paneles y la potencia instalada en kWp del grupo, y del proyecto, se calculan solos.
      </MensajeInfo>

      <section className="rejilla">
        <div className="indicador">
          <p className="indicador__etiqueta">Total de paneles</p>
          <p className="indicador__valor">{numero(totalCantidad, 0)}</p>
        </div>
        <div className="indicador">
          <p className="indicador__etiqueta">Potencia instalada</p>
          <p className="indicador__valor">{kwp(totalKwp)}</p>
        </div>
      </section>

      <Tabla<LotePaneles>
        titulo="Lotes registrados"
        columnas={[
          {
            clave: 'cantidad',
            titulo: 'Cantidad',
            numerica: true,
            render: (l) => numero(l.cantidad, 0),
          },
          {
            clave: 'potencia',
            titulo: 'Potencia unitaria',
            numerica: true,
            render: (l) => `${numero(l.potencia_wp, 2)} Wp`,
          },
          {
            clave: 'kwp',
            titulo: 'Subtotal',
            numerica: true,
            render: (l) => kwp((Number(l.cantidad) * Number(l.potencia_wp)) / 1000),
          },
          {
            clave: 'modelo',
            titulo: 'Marca / modelo',
            render: (l) => [l.marca, l.modelo].filter(Boolean).join(' ') || '—',
          },
          { clave: 'fecha', titulo: 'Instalado', render: (l) => fecha(l.fecha_instalacion) },
          ...(gestionar
            ? [
                {
                  clave: 'acciones',
                  titulo: 'Acciones',
                  render: (l: LotePaneles) => (
                    <div className="acciones no-imprimir">
                      <button
                        type="button"
                        className="boton boton--secundario boton--pequeno"
                        onClick={() => {
                          setEditando(l.id_lote);
                          setError(null);
                          setFormulario({
                            cantidad: String(l.cantidad),
                            potencia_wp: String(l.potencia_wp),
                            marca: l.marca ?? '',
                            modelo: l.modelo ?? '',
                            fecha_instalacion: l.fecha_instalacion?.slice(0, 10) ?? '',
                            observaciones: l.observaciones ?? '',
                          });
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="boton boton--peligro boton--pequeno"
                        onClick={() => setARetirar(l)}
                      >
                        Retirar
                      </button>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
        filas={lotes}
        claveFila={(l) => l.id_lote}
        cargando={consulta.isLoading}
        error={consulta.error}
        alReintentar={() => void consulta.refetch()}
        vacioTitulo="Este grupo aun no tiene paneles registrados"
        vacioDescripcion="Registre al menos un lote para conocer la potencia instalada real del grupo."
      />

      {gestionar && !formulario ? (
        <button
          type="button"
          className="boton no-imprimir"
          style={{ marginTop: '0.9rem' }}
          onClick={() => {
            setEditando(null);
            setError(null);
            setFormulario({ ...LOTE_FORMULARIO });
          }}
        >
          Agregar lote
        </button>
      ) : null}

      {formulario ? (
        <form onSubmit={guardar} noValidate style={{ marginTop: '0.9rem' }}>
          <fieldset className="grupo-alta">
            <legend>{editando ? 'Editar lote' : 'Nuevo lote de paneles'}</legend>
            <div className="formulario">
              <CampoTexto
                etiqueta="Cantidad de paneles"
                type="number"
                min="1"
                step="1"
                obligatorio
                value={formulario.cantidad}
                error={erroresCampo.cantidad}
                onChange={(e) => setFormulario({ ...formulario, cantidad: e.target.value })}
              />
              <CampoTexto
                etiqueta="Potencia unitaria (Wp)"
                type="number"
                min="0.01"
                step="0.01"
                obligatorio
                value={formulario.potencia_wp}
                error={erroresCampo.potencia_wp}
                ayuda="Ej. 440 o 640, segun la ficha tecnica del panel."
                onChange={(e) => setFormulario({ ...formulario, potencia_wp: e.target.value })}
              />
              <CampoTexto
                etiqueta="Marca"
                value={formulario.marca}
                onChange={(e) => setFormulario({ ...formulario, marca: e.target.value })}
              />
              <CampoTexto
                etiqueta="Modelo"
                value={formulario.modelo}
                onChange={(e) => setFormulario({ ...formulario, modelo: e.target.value })}
              />
              <CampoTexto
                etiqueta="Fecha de instalacion"
                type="date"
                value={formulario.fecha_instalacion}
                error={erroresCampo.fecha_instalacion}
                ayuda="Opcional. Util para distinguir la instalacion original de ampliaciones."
                onChange={(e) => setFormulario({ ...formulario, fecha_instalacion: e.target.value })}
              />
              <CampoArea
                etiqueta="Observaciones"
                value={formulario.observaciones}
                onChange={(e) => setFormulario({ ...formulario, observaciones: e.target.value })}
              />
            </div>
            <div className="acciones" style={{ marginTop: '0.9rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="boton boton--secundario"
                onClick={() => {
                  setFormulario(null);
                  setEditando(null);
                }}
              >
                Cancelar
              </button>
              <button type="submit" className="boton" disabled={ocupado}>
                {ocupado ? 'Guardando...' : 'Guardar lote'}
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}

      {aRetirar ? (
        <Confirmacion
          titulo="Retirar el lote de paneles"
          peligroso
          ocupado={ocupado}
          textoConfirmar="Retirar"
          descripcion={
            <p>
              Se retiraran <strong>{aRetirar.cantidad} panel(es)</strong> de{' '}
              {numero(aRetirar.potencia_wp, 2)} Wp del total activo del grupo. El registro no se
              borra: queda en el historico como referencia.
            </p>
          }
          alConfirmar={retirar}
          alCancelar={() => setARetirar(null)}
        />
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tarifas de energia
// ---------------------------------------------------------------------------

function PanelTarifas({ idProyecto }: { idProyecto: number }) {
  const { puede } = useSesion();
  const clienteConsultas = useQueryClient();
  const [anio, setAnio] = useState(anioActual());
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [nueva, setNueva] = useState<
    { trimestre: number; costo: string; motivo: string; aprobar: boolean } | null
  >(null);
  const [correccion, setCorreccion] = useState<
    { fila: FilaCalendarioTarifa; costo: string; motivo: string } | null
  >(null);
  const [impacto, setImpacto] = useState<Impacto | null>(null);
  const [copiar, setCopiar] = useState<FilaCalendarioTarifa | null>(null);
  const [anular, setAnular] = useState<{ fila: FilaCalendarioTarifa; motivo: string } | null>(null);
  const [cierre, setCierre] = useState<
    { fila: FilaCalendarioTarifa; mes: number; abrir: boolean; motivo: string } | null
  >(null);

  const gestionar = puede('tarifas.gestionar');
  const aprobar = puede('tarifas.aprobar');
  const recalcular = puede('tarifas.recalcular');

  const consulta = useQuery({
    queryKey: ['tarifas', idProyecto, anio],
    queryFn: async () => (await api.obtener<RespuestaTarifas>(`/projects/${idProyecto}/rates`, { anio })).datos,
  });

  const refrescar = () => {
    void consulta.refetch();
    void clienteConsultas.invalidateQueries({ queryKey: ['proyecto', idProyecto] });
    void clienteConsultas.invalidateQueries({ queryKey: ['tablero'] });
  };

  const ejecutar = async (accion: () => Promise<string>) => {
    setError(null);
    try {
      setExito(await accion());
      refrescar();
    } catch (fallo) {
      setError(fallo);
    }
  };

  const mutacion = useMutation({
    mutationFn: async (variables: { ruta: string; cuerpo: unknown; metodo?: 'POST' | 'PUT' }) => {
      const respuesta =
        variables.metodo === 'PUT'
          ? await api.actualizar<{ mensaje: string }>(variables.ruta, variables.cuerpo)
          : await api.crear<{ mensaje: string }>(variables.ruta, variables.cuerpo);
      return respuesta.datos.mensaje;
    },
  });

  const datos = consulta.data;
  const anios = Array.from({ length: 8 }, (_, i) => anioActual() - i);

  return (
    <>
      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error ? <MensajeError error={error} /> : null}

      {/* Aviso de actualizacion trimestral: el costo del kWh se pacta cada
          trimestre, asi que el sistema recuerda registrarlo a tiempo. */}
      {datos?.alerta?.requiereAtencion && datos.alerta.mensaje ? (
        <MensajeAlerta titulo="Actualizacion trimestral de la tarifa pendiente">
          {datos.alerta.mensaje}
          <p style={{ marginTop: '0.4rem', fontSize: '0.8rem' }}>
            Trimestre en curso: <strong>{datos.alerta.trimestreActual.etiqueta}</strong> · quedan{' '}
            {datos.alerta.diasRestantes} dia(s) · el siguiente es{' '}
            {datos.alerta.trimestreSiguiente.etiqueta}.
          </p>
        </MensajeAlerta>
      ) : null}

      <section className="tarjeta">
        <div className="tarjeta__titulo">
          <h2>Tarifas de energia (Q por kWh) · vigencia trimestral</h2>
          <div className="acciones no-imprimir">
            <CampoSelect etiqueta="Anio" value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
              {anios.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </CampoSelect>
          </div>
        </div>

        <MensajeInfo>
          El costo del kWh se pacta <strong>por trimestre calendario</strong>: los tres meses de un
          trimestre comparten siempre la misma tarifa. Solo una tarifa <strong>APROBADA</strong> puede
          usarse en reportes oficiales. Si un trimestre no tiene tarifa, la energia se conserva y su
          valor economico queda <strong>pendiente de tarifa</strong>: nunca se asume cero ni se arrastra
          la tarifa del trimestre anterior.
        </MensajeInfo>

        {datos ? (
          <>
            <section className="rejilla">
              <div className="indicador indicador--verde">
                <p className="indicador__etiqueta">Trimestres aprobados</p>
                <p className="indicador__valor">{datos.resumen.trimestresAprobados}</p>
                <p className="indicador__detalle">de 4 en el anio {anio}</p>
              </div>
              <div className="indicador indicador--ambar">
                <p className="indicador__etiqueta">En borrador</p>
                <p className="indicador__valor">{datos.resumen.trimestresBorrador}</p>
              </div>
              <div className="indicador">
                <p className="indicador__etiqueta">Sin tarifa</p>
                <p className="indicador__valor">{datos.resumen.trimestresSinTarifa}</p>
              </div>
              <div
                className={
                  datos.resumen.trimestresConProduccionSinTarifa > 0
                    ? 'indicador indicador--rojo'
                    : 'indicador'
                }
              >
                <p className="indicador__etiqueta">Con produccion sin tarifa</p>
                <p className="indicador__valor">{datos.resumen.trimestresConProduccionSinTarifa}</p>
                <p className="indicador__detalle">Requieren atencion inmediata</p>
              </div>
            </section>

            <div className="tabla-envoltura">
              <table>
                <caption>Calendario trimestral de tarifas del anio {anio}.</caption>
                <thead>
                  <tr>
                    <th scope="col">Trimestre</th>
                    <th scope="col">Meses que cubre</th>
                    <th scope="col" className="num">Tarifa Q/kWh</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Origen</th>
                    <th scope="col" className="num">Produccion</th>
                    <th scope="col">Registrado por</th>
                    <th scope="col">Aprobado por</th>
                    <th scope="col">Ultima modificacion</th>
                    <th scope="col" className="no-imprimir">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.calendario.map((fila) => (
                    <tr
                      key={fila.trimestre}
                      style={fila.requiereAtencion ? { background: 'var(--rojo-100)' } : undefined}
                    >
                      <th scope="row" style={{ position: 'static', background: 'transparent' }}>
                        {fila.etiqueta}
                        {fila.cerradoCompleto ? (
                          <span className="etiqueta etiqueta--gris" style={{ marginLeft: '0.35rem' }}>
                            Cerrado
                          </span>
                        ) : fila.cerradoParcial ? (
                          <span className="etiqueta etiqueta--ambar" style={{ marginLeft: '0.35rem' }}>
                            Cierre parcial
                          </span>
                        ) : null}
                      </th>
                      <td>
                        {fila.meses}
                        {fila.mesesCerrados.length > 0 ? (
                          <div style={{ fontSize: '0.75rem', color: 'var(--texto-suave)' }}>
                            Cerrados: {fila.mesesCerrados.map((m) => nombreMes(m)).join(', ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">
                        {fila.tarifa ? (
                          numero(fila.tarifa.costo_kwh, 6)
                        ) : (
                          <span style={{ color: 'var(--texto-suave)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {fila.tarifa ? (
                          <span className={claseEstado(fila.tarifa.estado)}>{textoEstado(fila.tarifa.estado)}</span>
                        ) : (
                          <span className="etiqueta etiqueta--rojo">Sin tarifa</span>
                        )}
                      </td>
                      <td>{fila.tarifa ? textoEstado(fila.tarifa.origen) : '—'}</td>
                      <td className="num">
                        {fila.registrosProduccion > 0 ? (
                          <>
                            {kwh(fila.kwh)}
                            {fila.registrosPendientes > 0 ? (
                              <div>
                                <span className="etiqueta etiqueta--ambar">
                                  {fila.registrosPendientes} sin valorizar
                                </span>
                              </div>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{fila.tarifa?.creado_por_nombre ?? '—'}</td>
                      <td>{fila.tarifa?.aprobado_por_nombre ?? '—'}</td>
                      <td>{fila.tarifa ? fechaHora(fila.tarifa.updated_at) : '—'}</td>
                      <td className="no-imprimir">
                        <div className="acciones">
                          {!fila.tarifa && gestionar && !fila.cerradoCompleto ? (
                            <>
                              <button
                                type="button"
                                className="boton boton--pequeno"
                                onClick={() => {
                                  setNueva({ trimestre: fila.trimestre, costo: '', motivo: '', aprobar: false });
                                  setError(null);
                                }}
                              >
                                Registrar
                              </button>
                              <button
                                type="button"
                                className="boton boton--secundario boton--pequeno"
                                onClick={() => setCopiar(fila)}
                              >
                                Copiar trimestre anterior
                              </button>
                            </>
                          ) : null}

                          {fila.tarifa?.estado === 'BORRADOR' && aprobar && !fila.cerradoCompleto ? (
                            <button
                              type="button"
                              className="boton boton--verde boton--pequeno"
                              onClick={() =>
                                void ejecutar(async () =>
                                  mutacion.mutateAsync({
                                    ruta: `/projects/${idProyecto}/rates/${fila.tarifa!.id_tarifa}/approve`,
                                    cuerpo: {},
                                  }),
                                )
                              }
                            >
                              Aprobar
                            </button>
                          ) : null}

                          {fila.tarifa?.estado === 'BORRADOR' && gestionar && !fila.cerradoCompleto ? (
                            <button
                              type="button"
                              className="boton boton--secundario boton--pequeno"
                              onClick={() =>
                                setNueva({
                                  trimestre: fila.trimestre,
                                  costo: String(fila.tarifa!.costo_kwh),
                                  motivo: '',
                                  aprobar: false,
                                })
                              }
                            >
                              Editar
                            </button>
                          ) : null}

                          {fila.tarifa?.estado === 'APROBADA' && recalcular && !fila.cerradoCompleto ? (
                            <button
                              type="button"
                              className="boton boton--secundario boton--pequeno"
                              onClick={() => {
                                setCorreccion({ fila, costo: String(fila.tarifa!.costo_kwh), motivo: '' });
                                setImpacto(null);
                              }}
                            >
                              Corregir
                            </button>
                          ) : null}

                          {fila.tarifa && aprobar && fila.tarifa.estado !== 'ANULADA' && !fila.cerradoCompleto ? (
                            <button
                              type="button"
                              className="boton boton--peligro boton--pequeno"
                              onClick={() => setAnular({ fila, motivo: '' })}
                            >
                              Anular
                            </button>
                          ) : null}

                          {/* El cierre contable sigue siendo MENSUAL: se elige
                              cual de los tres meses del trimestre se cierra. */}
                          {puede('tarifas.cerrar_mes') && fila.registrosProduccion > 0 ? (
                            <button
                              type="button"
                              className="boton boton--secundario boton--pequeno"
                              disabled={fila.cerradoCompleto}
                              onClick={() =>
                                setCierre({
                                  fila,
                                  mes:
                                    fila.mesesNumeros.find((m) => !fila.mesesCerrados.includes(m)) ??
                                    fila.mesesNumeros[0],
                                  abrir: false,
                                  motivo: '',
                                })
                              }
                            >
                              Cerrar mes
                            </button>
                          ) : null}

                          {fila.mesesCerrados.length > 0 && puede('tarifas.reabrir_mes') ? (
                            <button
                              type="button"
                              className="boton boton--secundario boton--pequeno"
                              onClick={() =>
                                setCierre({ fila, mes: fila.mesesCerrados[0], abrir: true, motivo: '' })
                              }
                            >
                              Reabrir mes
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : consulta.isLoading ? (
          <Cargando />
        ) : null}
      </section>

      {/* --------------------------- Registrar / editar --------------------------- */}
      {nueva ? (
        <Modal
          titulo={`Tarifa del ${etiquetaTrimestre(nueva.trimestre)} de ${anio}`}
          alCerrar={() => setNueva(null)}
        >
          {error ? <MensajeError error={error} /> : null}
          <MensajeInfo>
            Esta tarifa se aplicara a los tres meses del trimestre:{' '}
            <strong>{mesesDelTrimestre(nueva.trimestre)}</strong>.
          </MensajeInfo>
          <form
            noValidate
            onSubmit={(evento: FormEvent) => {
              evento.preventDefault();
              const existente = datos?.calendario.find((c) => c.trimestre === nueva.trimestre)?.tarifa;
              void ejecutar(async () => {
                const mensaje = existente
                  ? await mutacion.mutateAsync({
                      ruta: `/projects/${idProyecto}/rates/${existente.id_tarifa}`,
                      cuerpo: { costo_kwh: Number(nueva.costo), motivo: nueva.motivo || undefined },
                      metodo: 'PUT',
                    })
                  : await mutacion.mutateAsync({
                      ruta: `/projects/${idProyecto}/rates`,
                      cuerpo: {
                        anio,
                        trimestre: nueva.trimestre,
                        costo_kwh: Number(nueva.costo),
                        motivo: nueva.motivo || undefined,
                        aprobarInmediato: nueva.aprobar,
                      },
                    });
                setNueva(null);
                return mensaje;
              });
            }}
          >
            <div className="formulario">
              <CampoTexto
                etiqueta="Costo del kWh (GTQ)"
                type="number"
                min="0"
                step="0.000001"
                obligatorio
                value={nueva.costo}
                ayuda="Se almacena con 6 decimales. Debe ser mayor o igual a cero."
                onChange={(e) => setNueva({ ...nueva, costo: e.target.value })}
              />
              <CampoTexto
                etiqueta="Motivo o referencia"
                value={nueva.motivo}
                ayuda="Opcional: numero de contrato, acuerdo o resolucion."
                onChange={(e) => setNueva({ ...nueva, motivo: e.target.value })}
              />
              {aprobar ? (
                <CampoCasilla
                  etiqueta="Aprobar inmediatamente"
                  ancho
                  ayuda="Al aprobarla se valorizaran los registros pendientes de los tres meses del trimestre."
                  checked={nueva.aprobar}
                  onChange={(e) => setNueva({ ...nueva, aprobar: e.target.checked })}
                />
              ) : null}
            </div>
            <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button type="button" className="boton boton--secundario" onClick={() => setNueva(null)}>
                Cancelar
              </button>
              <button type="submit" className="boton" disabled={mutacion.isPending}>
                Guardar tarifa
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* --------------------------- Copiar trimestre anterior --------------------------- */}
      {copiar ? (
        <Confirmacion
          titulo={`Copiar la tarifa del trimestre anterior al ${copiar.etiqueta} de ${anio}`}
          textoConfirmar="Confirmar copia"
          ocupado={mutacion.isPending}
          descripcion={
            <p>
              Se creara un <strong>BORRADOR</strong> con la tarifa aprobada del trimestre inmediato
              anterior. La copia nunca se aplica de forma silenciosa: debera revisarla y aprobarla para
              que tenga efecto sobre los tres meses de {copiar.meses}.
            </p>
          }
          alConfirmar={() =>
            void ejecutar(async () => {
              const mensaje = await mutacion.mutateAsync({
                ruta: `/projects/${idProyecto}/rates/copy-previous`,
                cuerpo: { anio, trimestre: copiar.trimestre, confirmado: true },
              });
              setCopiar(null);
              return mensaje;
            })
          }
          alCancelar={() => setCopiar(null)}
        />
      ) : null}

      {/* --------------------------- Correccion con impacto --------------------------- */}
      {correccion ? (
        <Modal
          titulo={`Corregir la tarifa del ${correccion.fila.etiqueta} de ${anio}`}
          alCerrar={() => {
            setCorreccion(null);
            setImpacto(null);
          }}
        >
          {error ? <MensajeError error={error} /> : null}
          <MensajeAlerta titulo="Esta tarifa ya fue utilizada">
            Corregir una tarifa aprobada modifica valores historicos ya calculados de los tres meses del
            trimestre ({correccion.fila.meses}). Debe revisar el analisis de impacto, indicar un motivo y
            confirmar. Todo el cambio queda auditado (antes y despues).
          </MensajeAlerta>

          <div className="formulario">
            <CampoTexto
              etiqueta="Nuevo costo del kWh (GTQ)"
              type="number"
              min="0"
              step="0.000001"
              obligatorio
              value={correccion.costo}
              onChange={(e) => {
                setCorreccion({ ...correccion, costo: e.target.value });
                setImpacto(null);
              }}
            />
            <CampoArea
              etiqueta="Motivo de la correccion"
              obligatorio
              value={correccion.motivo}
              ayuda="Minimo 10 caracteres. Quedara registrado en la auditoria."
              onChange={(e) => setCorreccion({ ...correccion, motivo: e.target.value })}
            />
          </div>

          <div className="acciones" style={{ marginTop: '0.6rem' }}>
            <button
              type="button"
              className="boton boton--secundario"
              disabled={!correccion.costo}
              onClick={() =>
                void (async () => {
                  setError(null);
                  try {
                    const respuesta = await api.crear<Impacto>(
                      `/projects/${idProyecto}/rates/${correccion.fila.tarifa!.id_tarifa}/impact`,
                      { costo_kwh: Number(correccion.costo) },
                    );
                    setImpacto(respuesta.datos);
                  } catch (fallo) {
                    setError(fallo);
                  }
                })()
              }
            >
              Analizar impacto
            </button>
          </div>

          {impacto ? (
            <>
              <div className="tabla-envoltura" style={{ marginTop: '1rem' }}>
                <table>
                  <caption>Impacto de la correccion sobre los registros ya valorizados.</caption>
                  <tbody>
                    <tr>
                      <th scope="row">Periodo afectado</th>
                      <td className="num">{impacto.etiqueta}</td>
                    </tr>
                    <tr>
                      <th scope="row">Registros afectados</th>
                      <td className="num">{numero(impacto.registrosAfectados, 0)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Energia afectada</th>
                      <td className="num">{kwh(impacto.kwhAfectados)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Tarifa actual</th>
                      <td className="num">{formatoTarifa(impacto.costoActual)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Tarifa propuesta</th>
                      <td className="num">{formatoTarifa(impacto.costoPropuesto)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Valor anterior</th>
                      <td className="num">{quetzales(impacto.valorAnterior)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Valor nuevo</th>
                      <td className="num">{quetzales(impacto.valorNuevo)}</td>
                    </tr>
                    <tr style={{ fontWeight: 700 }}>
                      <th scope="row">Diferencia</th>
                      <td className="num">{quetzales(impacto.diferencia)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <MensajeAlerta>{impacto.advertencia}</MensajeAlerta>
              {impacto.mesesCerrados.length > 0 ? (
                <MensajeAlerta titulo="Hay meses cerrados en el trimestre">
                  {impacto.mesesCerrados.map((m) => nombreMes(m)).join(', ')} ya estan cerrados
                  contablemente. Debe reabrirlos antes de poder corregir la tarifa.
                </MensajeAlerta>
              ) : null}
            </>
          ) : null}

          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="boton boton--secundario"
              onClick={() => {
                setCorreccion(null);
                setImpacto(null);
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="boton boton--peligro"
              disabled={!impacto || correccion.motivo.trim().length < 10 || mutacion.isPending}
              onClick={() =>
                void ejecutar(async () => {
                  const mensaje = await mutacion.mutateAsync({
                    ruta: `/projects/${idProyecto}/rates/${correccion.fila.tarifa!.id_tarifa}/recalculate`,
                    cuerpo: {
                      costo_kwh: Number(correccion.costo),
                      motivo: correccion.motivo,
                      confirmado: true,
                    },
                  });
                  setCorreccion(null);
                  setImpacto(null);
                  return mensaje;
                })
              }
            >
              Confirmar correccion y recalcular
            </button>
          </div>
          {!impacto ? (
            <p style={{ fontSize: '0.78rem', color: 'var(--texto-suave)', marginTop: '0.5rem' }}>
              Debe analizar el impacto antes de poder confirmar.
            </p>
          ) : null}
        </Modal>
      ) : null}

      {/* --------------------------- Anular --------------------------- */}
      {anular ? (
        <Confirmacion
          titulo={`Anular la tarifa del ${anular.fila.etiqueta} de ${anio}`}
          peligroso
          textoConfirmar="Anular tarifa"
          ocupado={mutacion.isPending}
          descripcion={
            <p>
              Los kWh registrados se conservan intactos, pero los registros de{' '}
              {anular.fila.meses} valorizados con esta tarifa volveran al estado{' '}
              <strong>pendiente de tarifa</strong> y su valor economico dejara de mostrarse hasta que se
              registre y apruebe una nueva tarifa trimestral.
            </p>
          }
          alConfirmar={() =>
            void ejecutar(async () => {
              const mensaje = await mutacion.mutateAsync({
                ruta: `/projects/${idProyecto}/rates/${anular.fila.tarifa!.id_tarifa}/annul`,
                cuerpo: { motivo: anular.motivo },
              });
              setAnular(null);
              return mensaje;
            })
          }
          alCancelar={() => setAnular(null)}
        >
          <CampoArea
            etiqueta="Motivo de la anulacion"
            obligatorio
            value={anular.motivo}
            ayuda="Minimo 10 caracteres."
            onChange={(e) => setAnular({ ...anular, motivo: e.target.value })}
          />
        </Confirmacion>
      ) : null}

      {/* --------------------------- Cierre / reapertura --------------------------- */}
      {cierre ? (
        <Confirmacion
          titulo={
            cierre.abrir
              ? `Reabrir un mes del ${cierre.fila.etiqueta} de ${anio}`
              : `Cerrar un mes del ${cierre.fila.etiqueta} de ${anio}`
          }
          peligroso={cierre.abrir}
          textoConfirmar={cierre.abrir ? 'Reabrir periodo' : 'Cerrar periodo'}
          ocupado={mutacion.isPending}
          descripcion={
            cierre.abrir ? (
              <p>
                Reabrir un mes cerrado permite modificar tarifas y produccion historica. Requiere un motivo
                que quedara registrado en la auditoria.
              </p>
            ) : (
              <p>
                El cierre contable es <strong>mensual</strong> aunque la tarifa sea trimestral. Al cerrar
                el mes no se podran modificar tarifas ni produccion de ese periodo sin una reapertura
                autorizada. El sistema exige que no queden registros sin tarifa aprobada.
              </p>
            )
          }
          alConfirmar={() =>
            void ejecutar(async () => {
              const mensaje = await mutacion.mutateAsync({
                ruta: `/projects/${idProyecto}/rates/${cierre.abrir ? 'reopen' : 'close'}`,
                cuerpo: { anio, mes: cierre.mes, motivo: cierre.motivo || undefined },
              });
              setCierre(null);
              return mensaje;
            })
          }
          alCancelar={() => setCierre(null)}
        >
          <div className="formulario">
            <CampoSelect
              etiqueta="Mes del trimestre"
              value={String(cierre.mes)}
              onChange={(e) => setCierre({ ...cierre, mes: Number(e.target.value) })}
            >
              {(cierre.abrir ? cierre.fila.mesesCerrados : cierre.fila.mesesNumeros).map((m) => (
                <option key={m} value={m} disabled={!cierre.abrir && cierre.fila.mesesCerrados.includes(m)}>
                  {nombreMes(m)}
                  {!cierre.abrir && cierre.fila.mesesCerrados.includes(m) ? ' (ya cerrado)' : ''}
                </option>
              ))}
            </CampoSelect>
          </div>
          <CampoArea
            etiqueta="Motivo"
            obligatorio={cierre.abrir}
            value={cierre.motivo}
            ayuda={cierre.abrir ? 'Obligatorio, minimo 10 caracteres.' : 'Opcional.'}
            onChange={(e) => setCierre({ ...cierre, motivo: e.target.value })}
          />
        </Confirmacion>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Proyecciones mensuales
// ---------------------------------------------------------------------------

function PanelProyecciones({ idProyecto }: { idProyecto: number }) {
  const { puede } = useSesion();
  const [anio, setAnio] = useState(anioActual());
  const [valores, setValores] = useState<Record<number, string>>({});
  const [editando, setEditando] = useState(false);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copia, setCopia] = useState<{ origen: number; factor: string } | null>(null);

  const gestionar = puede('proyecciones.gestionar');
  const aprobar = puede('proyecciones.aprobar');

  const consulta = useQuery({
    queryKey: ['proyecciones', idProyecto, anio],
    queryFn: async () =>
      (await api.obtener<RespuestaProyecciones>(`/projects/${idProyecto}/projections`, { anio })).datos,
  });

  const mutacion = useMutation({
    mutationFn: async (variables: { ruta: string; cuerpo: unknown }) =>
      (await api.crear<{ mensaje: string }>(variables.ruta, variables.cuerpo)).datos.mensaje,
  });

  const ejecutar = async (accion: () => Promise<string>) => {
    setError(null);
    try {
      setExito(await accion());
      void consulta.refetch();
    } catch (fallo) {
      setError(fallo);
    }
  };

  const iniciarEdicion = () => {
    const iniciales: Record<number, string> = {};
    consulta.data?.calendario.forEach((mes) => {
      iniciales[mes.mes] = mes.proyeccion ? String(mes.proyeccion.proyeccion_kwh) : '';
    });
    setValores(iniciales);
    setEditando(true);
  };

  const guardar = async (aprobarInmediato: boolean) => {
    const meses = Object.entries(valores)
      .filter(([, valor]) => valor !== '')
      .map(([mes, valor]) => ({ mes: Number(mes), proyeccion_kwh: Number(valor) }));

    if (meses.length === 0) {
      setError(new Error('Ingrese al menos un mes con proyeccion.'));
      return;
    }

    await ejecutar(async () => {
      const mensaje = await mutacion.mutateAsync({
        ruta: `/projects/${idProyecto}/projections`,
        cuerpo: { anio, meses, aprobarInmediato },
      });
      setEditando(false);
      return mensaje;
    });
  };

  const datos = consulta.data;
  const anios = Array.from({ length: 9 }, (_, i) => anioActual() + 1 - i);

  return (
    <>
      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error ? <MensajeError error={error} /> : null}

      <section className="tarjeta">
        <div className="tarjeta__titulo">
          <h2>Proyecciones mensuales de generacion (kWh)</h2>
          <div className="acciones no-imprimir">
            <CampoSelect etiqueta="Anio" value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
              {anios.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </CampoSelect>
            {gestionar && !editando ? (
              <>
                <button type="button" className="boton" onClick={iniciarEdicion}>
                  Capturar proyeccion
                </button>
                <button
                  type="button"
                  className="boton boton--secundario"
                  onClick={() => setCopia({ origen: anio - 1, factor: '1' })}
                >
                  Copiar de otro anio
                </button>
              </>
            ) : null}
            {aprobar && !editando ? (
              <button
                type="button"
                className="boton boton--verde"
                onClick={() =>
                  void ejecutar(() =>
                    mutacion.mutateAsync({
                      ruta: `/projects/${idProyecto}/projections/approve-year`,
                      cuerpo: { anio },
                    }),
                  )
                }
              >
                Aprobar borradores del anio
              </button>
            ) : null}
          </div>
        </div>

        <MensajeInfo>
          La proyeccion se expresa en <strong>kWh</strong> y es independiente de la tarifa monetaria
          (Q/kWh). El anio siempre se elige de forma explicita: el sistema nunca lo deduce.
        </MensajeInfo>

        {consulta.isLoading ? <Cargando /> : null}

        {datos ? (
          <>
            <section className="rejilla">
              <div className="indicador">
                <p className="indicador__etiqueta">Proyeccion anual aprobada</p>
                <p className="indicador__valor">{kwh(datos.totales.proyeccion_kwh)}</p>
                <p className="indicador__detalle">{datos.totales.mesesAprobados} mes(es) aprobados</p>
              </div>
              <div className="indicador">
                <p className="indicador__etiqueta">Generacion real del anio</p>
                <p className="indicador__valor">{kwh(datos.totales.generacion_kwh)}</p>
              </div>
              <div
                className={
                  datos.totales.cumplimiento === null
                    ? 'indicador'
                    : datos.totales.cumplimiento >= 100
                      ? 'indicador indicador--verde'
                      : 'indicador indicador--ambar'
                }
              >
                <p className="indicador__etiqueta">Cumplimiento anual</p>
                <p className="indicador__valor">
                  {datos.totales.cumplimiento === null ? 'Sin proyeccion' : porcentaje(datos.totales.cumplimiento)}
                </p>
              </div>
              <div className={datos.totales.mesesSinProyeccion > 0 ? 'indicador indicador--ambar' : 'indicador'}>
                <p className="indicador__etiqueta">Meses sin proyeccion</p>
                <p className="indicador__valor">{datos.totales.mesesSinProyeccion}</p>
              </div>
            </section>

            <div className="tabla-envoltura">
              <table>
                <caption>Calendario anual de proyecciones del anio {anio}.</caption>
                <thead>
                  <tr>
                    <th scope="col">Mes</th>
                    <th scope="col" className="num">Proyeccion kWh</th>
                    <th scope="col" className="num">Generacion real kWh</th>
                    <th scope="col" className="num">Cumplimiento</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Origen</th>
                    <th scope="col">Ultima modificacion</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.calendario.map((fila) => (
                    <tr key={fila.mes}>
                      <th scope="row" style={{ position: 'static', background: 'transparent' }}>
                        {fila.mesNombre}
                      </th>
                      <td className="num">
                        {editando ? (
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            aria-label={`Proyeccion de ${fila.mesNombre}`}
                            value={valores[fila.mes] ?? ''}
                            onChange={(e) => setValores({ ...valores, [fila.mes]: e.target.value })}
                            style={{ width: '130px', textAlign: 'right' }}
                          />
                        ) : fila.proyeccion ? (
                          numero(fila.proyeccion.proyeccion_kwh)
                        ) : (
                          <span style={{ color: 'var(--texto-suave)' }}>—</span>
                        )}
                      </td>
                      <td className="num">{numero(fila.generacion_kwh)}</td>
                      <td className="num">
                        {fila.etiquetaCumplimiento ? (
                          <span style={{ color: 'var(--texto-suave)' }}>{fila.etiquetaCumplimiento}</span>
                        ) : (
                          <span
                            className={
                              (fila.cumplimiento ?? 0) >= 100 ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--ambar'
                            }
                          >
                            {porcentaje(fila.cumplimiento)}
                          </span>
                        )}
                      </td>
                      <td>
                        {fila.proyeccion ? (
                          <span className={claseEstado(fila.proyeccion.estado)}>
                            {textoEstado(fila.proyeccion.estado)}
                          </span>
                        ) : (
                          <span className="etiqueta etiqueta--gris">Sin proyeccion</span>
                        )}
                      </td>
                      <td>{fila.proyeccion ? textoEstado(fila.proyeccion.origen) : '—'}</td>
                      <td>{fila.proyeccion ? fechaHora(fila.proyeccion.updated_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {editando ? (
              <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
                <button type="button" className="boton boton--secundario" onClick={() => setEditando(false)}>
                  Cancelar
                </button>
                <button type="button" className="boton" onClick={() => void guardar(false)} disabled={mutacion.isPending}>
                  Guardar como borrador
                </button>
                {aprobar ? (
                  <button
                    type="button"
                    className="boton boton--verde"
                    onClick={() => void guardar(true)}
                    disabled={mutacion.isPending}
                  >
                    Guardar y aprobar
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      {copia ? (
        <Confirmacion
          titulo={`Copiar proyecciones al anio ${anio}`}
          textoConfirmar="Copiar como borrador"
          ocupado={mutacion.isPending}
          descripcion={
            <p>
              Se copiaran las proyecciones del anio de origen como <strong>borradores</strong> del anio{' '}
              {anio}. Los meses que ya tengan proyeccion no se sobrescriben.
            </p>
          }
          alConfirmar={() =>
            void ejecutar(async () => {
              const mensaje = await mutacion.mutateAsync({
                ruta: `/projects/${idProyecto}/projections/copy-year`,
                cuerpo: {
                  anioOrigen: copia.origen,
                  anioDestino: anio,
                  factor: Number(copia.factor),
                  confirmado: true,
                },
              });
              setCopia(null);
              return mensaje;
            })
          }
          alCancelar={() => setCopia(null)}
        >
          <div className="formulario" style={{ marginTop: '0.8rem' }}>
            <CampoTexto
              etiqueta="Anio de origen"
              type="number"
              min="2000"
              max="2100"
              value={copia.origen}
              onChange={(e) => setCopia({ ...copia, origen: Number(e.target.value) })}
            />
            <CampoTexto
              etiqueta="Factor de ajuste"
              type="number"
              min="0"
              max="10"
              step="0.01"
              value={copia.factor}
              ayuda="1 copia el mismo valor; 1.05 lo incrementa 5 %."
              onChange={(e) => setCopia({ ...copia, factor: e.target.value })}
            />
          </div>
        </Confirmacion>
      ) : null}
    </>
  );
}
