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
}

interface TarifaMes {
  id_tarifa: number;
  mes: number;
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
  mes: number;
  mesNombre: string;
  tarifa: TarifaMes | null;
  cerrado: boolean;
  registrosProduccion: number;
  registrosPendientes: number;
  kwh: number;
  requiereAtencion: boolean;
}

interface RespuestaTarifas {
  anio: number;
  id_proyecto: number;
  calendario: FilaCalendarioTarifa[];
  resumen: {
    mesesAprobados: number;
    mesesBorrador: number;
    mesesSinTarifa: number;
    mesesConProduccionSinTarifa: number;
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
  mes: number;
  costoActual: number;
  costoPropuesto: number;
  registrosAfectados: number;
  kwhAfectados: number;
  valorAnterior: number;
  valorNuevo: number;
  diferencia: number;
  mesCerrado: boolean;
  advertencia: string;
}

type Pestana = 'resumen' | 'tarifas' | 'proyecciones';

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
// Tarifas de energia
// ---------------------------------------------------------------------------

function PanelTarifas({ idProyecto }: { idProyecto: number }) {
  const { puede } = useSesion();
  const clienteConsultas = useQueryClient();
  const [anio, setAnio] = useState(anioActual());
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [nueva, setNueva] = useState<{ mes: number; costo: string; motivo: string; aprobar: boolean } | null>(null);
  const [correccion, setCorreccion] = useState<{ fila: FilaCalendarioTarifa; costo: string; motivo: string } | null>(null);
  const [impacto, setImpacto] = useState<Impacto | null>(null);
  const [copiar, setCopiar] = useState<FilaCalendarioTarifa | null>(null);
  const [anular, setAnular] = useState<{ fila: FilaCalendarioTarifa; motivo: string } | null>(null);
  const [cierre, setCierre] = useState<{ fila: FilaCalendarioTarifa; abrir: boolean; motivo: string } | null>(null);

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

      <section className="tarjeta">
        <div className="tarjeta__titulo">
          <h2>Tarifas de energia (Q por kWh)</h2>
          <div className="acciones no-imprimir">
            <CampoSelect etiqueta="Anio" value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
              {anios.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </CampoSelect>
          </div>
        </div>

        <MensajeInfo>
          Solo una tarifa <strong>APROBADA</strong> puede usarse en reportes oficiales. Si un mes no tiene
          tarifa, la energia se conserva y el valor economico queda <strong>pendiente de tarifa</strong>:
          nunca se asume cero ni se arrastra la tarifa del mes anterior.
        </MensajeInfo>

        {datos ? (
          <>
            <section className="rejilla">
              <div className="indicador indicador--verde">
                <p className="indicador__etiqueta">Meses aprobados</p>
                <p className="indicador__valor">{datos.resumen.mesesAprobados}</p>
              </div>
              <div className="indicador indicador--ambar">
                <p className="indicador__etiqueta">En borrador</p>
                <p className="indicador__valor">{datos.resumen.mesesBorrador}</p>
              </div>
              <div className="indicador">
                <p className="indicador__etiqueta">Sin tarifa</p>
                <p className="indicador__valor">{datos.resumen.mesesSinTarifa}</p>
              </div>
              <div className={datos.resumen.mesesConProduccionSinTarifa > 0 ? 'indicador indicador--rojo' : 'indicador'}>
                <p className="indicador__etiqueta">Con produccion sin tarifa</p>
                <p className="indicador__valor">{datos.resumen.mesesConProduccionSinTarifa}</p>
                <p className="indicador__detalle">Requieren atencion inmediata</p>
              </div>
            </section>

            <div className="tabla-envoltura">
              <table>
                <caption>Calendario anual de tarifas del anio {anio}.</caption>
                <thead>
                  <tr>
                    <th scope="col">Mes</th>
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
                    <tr key={fila.mes} style={fila.requiereAtencion ? { background: 'var(--rojo-100)' } : undefined}>
                      <th scope="row" style={{ position: 'static', background: 'transparent' }}>
                        {fila.mesNombre}
                        {fila.cerrado ? (
                          <span className="etiqueta etiqueta--gris" style={{ marginLeft: '0.35rem' }}>
                            Cerrado
                          </span>
                        ) : null}
                      </th>
                      <td className="num">
                        {fila.tarifa ? numero(fila.tarifa.costo_kwh, 6) : <span style={{ color: 'var(--texto-suave)' }}>—</span>}
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
                          {!fila.tarifa && gestionar && !fila.cerrado ? (
                            <>
                              <button
                                type="button"
                                className="boton boton--pequeno"
                                onClick={() => {
                                  setNueva({ mes: fila.mes, costo: '', motivo: '', aprobar: false });
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
                                Copiar mes anterior
                              </button>
                            </>
                          ) : null}

                          {fila.tarifa?.estado === 'BORRADOR' && aprobar && !fila.cerrado ? (
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

                          {fila.tarifa?.estado === 'BORRADOR' && gestionar && !fila.cerrado ? (
                            <button
                              type="button"
                              className="boton boton--secundario boton--pequeno"
                              onClick={() =>
                                setNueva({
                                  mes: fila.mes,
                                  costo: String(fila.tarifa!.costo_kwh),
                                  motivo: '',
                                  aprobar: false,
                                })
                              }
                            >
                              Editar
                            </button>
                          ) : null}

                          {fila.tarifa?.estado === 'APROBADA' && recalcular && !fila.cerrado ? (
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

                          {fila.tarifa && aprobar && fila.tarifa.estado !== 'ANULADA' && !fila.cerrado ? (
                            <button
                              type="button"
                              className="boton boton--peligro boton--pequeno"
                              onClick={() => setAnular({ fila, motivo: '' })}
                            >
                              Anular
                            </button>
                          ) : null}

                          {!fila.cerrado && puede('tarifas.cerrar_mes') && fila.registrosProduccion > 0 ? (
                            <button
                              type="button"
                              className="boton boton--secundario boton--pequeno"
                              onClick={() => setCierre({ fila, abrir: false, motivo: '' })}
                            >
                              Cerrar mes
                            </button>
                          ) : null}

                          {fila.cerrado && puede('tarifas.reabrir_mes') ? (
                            <button
                              type="button"
                              className="boton boton--secundario boton--pequeno"
                              onClick={() => setCierre({ fila, abrir: true, motivo: '' })}
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
          titulo={`Tarifa de ${nombreMes(nueva.mes)} ${anio}`}
          alCerrar={() => setNueva(null)}
        >
          {error ? <MensajeError error={error} /> : null}
          <form
            noValidate
            onSubmit={(evento: FormEvent) => {
              evento.preventDefault();
              const existente = datos?.calendario.find((c) => c.mes === nueva.mes)?.tarifa;
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
                        mes: nueva.mes,
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
                  ayuda="Al aprobarla se valorizaran automaticamente los registros de ese mes que estaban pendientes."
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

      {/* --------------------------- Copiar mes anterior --------------------------- */}
      {copiar ? (
        <Confirmacion
          titulo={`Copiar la tarifa del mes anterior a ${copiar.mesNombre} ${anio}`}
          textoConfirmar="Confirmar copia"
          ocupado={mutacion.isPending}
          descripcion={
            <p>
              Se creara un <strong>BORRADOR</strong> con la tarifa aprobada del mes inmediato anterior. La
              copia nunca se aplica de forma silenciosa: debera revisarla y aprobarla para que tenga efecto.
            </p>
          }
          alConfirmar={() =>
            void ejecutar(async () => {
              const mensaje = await mutacion.mutateAsync({
                ruta: `/projects/${idProyecto}/rates/copy-previous`,
                cuerpo: { anio, mes: copiar.mes, confirmado: true },
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
          titulo={`Corregir la tarifa de ${correccion.fila.mesNombre} ${anio}`}
          alCerrar={() => {
            setCorreccion(null);
            setImpacto(null);
          }}
        >
          {error ? <MensajeError error={error} /> : null}
          <MensajeAlerta titulo="Esta tarifa ya fue utilizada">
            Corregir una tarifa aprobada modifica valores historicos ya calculados. Debe revisar el analisis
            de impacto, indicar un motivo y confirmar. Todo el cambio queda auditado (antes y despues).
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
          titulo={`Anular la tarifa de ${anular.fila.mesNombre} ${anio}`}
          peligroso
          textoConfirmar="Anular tarifa"
          ocupado={mutacion.isPending}
          descripcion={
            <p>
              Los kWh registrados se conservan intactos, pero los registros valorizados con esta tarifa
              volveran al estado <strong>pendiente de tarifa</strong> y su valor economico dejara de
              mostrarse hasta que se registre y apruebe una nueva tarifa.
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
              ? `Reabrir ${cierre.fila.mesNombre} ${anio}`
              : `Cerrar ${cierre.fila.mesNombre} ${anio}`
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
                Al cerrar el periodo no se podran modificar tarifas ni produccion de ese mes sin una
                reapertura autorizada. El sistema exige que no queden registros sin tarifa aprobada.
              </p>
            )
          }
          alConfirmar={() =>
            void ejecutar(async () => {
              const mensaje = await mutacion.mutateAsync({
                ruta: `/projects/${idProyecto}/rates/${cierre.abrir ? 'reopen' : 'close'}`,
                cuerpo: { anio, mes: cierre.fila.mes, motivo: cierre.motivo || undefined },
              });
              setCierre(null);
              return mensaje;
            })
          }
          alCancelar={() => setCierre(null)}
        >
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
