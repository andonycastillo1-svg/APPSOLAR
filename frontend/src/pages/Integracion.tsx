import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { useCatalogos } from '../hooks/useCatalogos';
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
import { claseEstado, fecha, fechaHora, hoyISO, numero, textoEstado } from '../lib/formato';

interface ConfiguracionApi {
  id_api: number;
  marca: string;
  nombre: string;
  endpoint: string;
  ip_autorizada: string | null;
  usuario_api: string | null;
  usuario_api_enmascarado: string | null;
  secreto_ref: string | null;
  credencialConfigurada: boolean;
  modo: 'MOCK' | 'REAL';
  estado: string;
  timeout_s: number;
  max_reintentos: number;
  sync_programada: number;
  sync_hora: string | null;
  ultima_prueba: string | null;
  resultado_ultima_prueba: string | null;
  ultima_sincronizacion: string | null;
}

interface Ejecucion {
  id_sync: number;
  tipo: string;
  modo: string;
  estado: string;
  rango_desde: string | null;
  rango_hasta: string | null;
  granularidad: string;
  filas_recibidas: number;
  insertadas: number;
  actualizadas: number;
  rechazadas: number;
  duracion_ms: number | null;
  codigo_error: string | null;
  mensaje: string | null;
  usuario: string | null;
  proyecto: string | null;
  iniciada_en: string;
}

interface ResultadoSync {
  id_sync: number;
  estado: string;
  modo: string;
  filasRecibidas: number;
  insertadas: number;
  actualizadas: number;
  rechazadas: number;
  pendientesTarifa: number;
  duracionMs: number;
  advertencias: string[];
  mensaje: string;
  esSimulado: boolean;
  etiquetaOrigen: string;
}

export function PaginaIntegracion() {
  const { puede } = useSesion();
  const catalogos = useCatalogos();
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<ResultadoSync | null>(null);
  const [editar, setEditar] = useState<ConfiguracionApi | null>(null);
  const [sincronizar, setSincronizar] = useState<{
    id_api: number;
    id_proyecto: string;
    id_inversor: string;
    desde: string;
    hasta: string;
    granularidad: string;
  } | null>(null);

  const configuracion = useQuery({
    queryKey: ['huawei-config'],
    queryFn: async () => {
      const respuesta = await api.obtener<ConfiguracionApi[]>('/integrations/huawei/config');
      return { lista: respuesta.datos, meta: respuesta.meta as Record<string, unknown> };
    },
  });

  const ejecuciones = useListado<Ejecucion>('huawei-runs', '/integrations/huawei/runs', {});

  const probar = async (idApi: number) => {
    setOcupado(true);
    setError(null);
    setExito(null);
    try {
      const respuesta = await api.crear<{ modo: string; mensaje: string; ip_saliente: string | null }>(
        '/integrations/huawei/test',
        { id_api: idApi },
      );
      setExito(
        `${respuesta.datos.mensaje}${respuesta.datos.ip_saliente ? ` IP de salida detectada: ${respuesta.datos.ip_saliente}.` : ''}`,
      );
      void configuracion.refetch();
    } catch (fallo) {
      setError(fallo);
      void configuracion.refetch();
    } finally {
      setOcupado(false);
    }
  };

  const ejecutarSync = async () => {
    if (!sincronizar) return;
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await api.crear<ResultadoSync>('/integrations/huawei/sync', {
        id_api: sincronizar.id_api,
        id_proyecto: sincronizar.id_proyecto ? Number(sincronizar.id_proyecto) : null,
        id_inversor: sincronizar.id_inversor ? Number(sincronizar.id_inversor) : null,
        desde: sincronizar.desde,
        hasta: sincronizar.hasta,
        granularidad: sincronizar.granularidad,
      });
      setResultado(respuesta.datos);
      setSincronizar(null);
      ejecuciones.recargar();
      void configuracion.refetch();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const guardarConfig = async () => {
    if (!editar) return;
    setOcupado(true);
    setError(null);
    try {
      await api.actualizar(`/integrations/huawei/config/${editar.id_api}`, {
        nombre: editar.nombre,
        endpoint: editar.endpoint,
        ip_autorizada: editar.ip_autorizada || null,
        usuario_api: editar.usuario_api || null,
        modo: editar.modo,
        estado: editar.estado,
        timeout_s: Number(editar.timeout_s),
        max_reintentos: Number(editar.max_reintentos),
        sync_programada: Boolean(editar.sync_programada),
        sync_hora: editar.sync_hora || null,
      });
      setExito('Configuracion de integracion actualizada.');
      setEditar(null);
      void configuracion.refetch();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const meta = configuracion.data?.meta;
  const pasos = (meta?.pasosParaActivarReal as string[]) ?? [];

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Integracion Huawei SmartPVMS</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Consumo de la API autorizada del fabricante mediante el servicio interno de integracion. La
            plataforma complementa las herramientas oficiales; no las sustituye.
          </p>
        </div>
      </div>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error ? <MensajeError error={error} /> : null}

      {meta?.advertenciaMock ? (
        <MensajeAlerta titulo="Modo simulado activo">
          {String(meta.advertenciaMock)} Los registros creados en este modo quedan marcados con origen
          Huawei y aparecen etiquetados como simulados en las ejecuciones.
        </MensajeAlerta>
      ) : null}

      {configuracion.isLoading ? <Cargando /> : null}
      {configuracion.error ? <MensajeError error={configuracion.error} /> : null}

      {configuracion.data?.lista.map((api_) => (
        <section className="tarjeta" key={api_.id_api}>
          <div className="tarjeta__titulo">
            <h2>
              {api_.nombre}{' '}
              <span className={api_.modo === 'MOCK' ? 'etiqueta etiqueta--azul' : 'etiqueta etiqueta--verde'}>
                {api_.modo === 'MOCK' ? 'Simulado (sandbox)' : 'Real'}
              </span>{' '}
              <span className={claseEstado(api_.estado)}>{textoEstado(api_.estado)}</span>
            </h2>
            <div className="acciones no-imprimir">
              {puede('huawei.sincronizar') ? (
                <>
                  <button
                    type="button"
                    className="boton boton--secundario"
                    disabled={ocupado}
                    onClick={() => void probar(api_.id_api)}
                  >
                    Probar conexion
                  </button>
                  <button
                    type="button"
                    className="boton"
                    onClick={() => {
                      const hasta = hoyISO();
                      const desde = new Date(`${hasta}T00:00:00Z`);
                      desde.setUTCDate(desde.getUTCDate() - 7);
                      setError(null);
                      setSincronizar({
                        id_api: api_.id_api,
                        id_proyecto: '',
                        id_inversor: '',
                        desde: desde.toISOString().slice(0, 10),
                        hasta,
                        granularidad: 'DIARIA',
                      });
                    }}
                  >
                    Sincronizar ahora
                  </button>
                </>
              ) : null}
              {puede('huawei.configurar') ? (
                <button type="button" className="boton boton--secundario" onClick={() => setEditar({ ...api_ })}>
                  Configurar
                </button>
              ) : null}
            </div>
          </div>

          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 1rem', fontSize: '0.87rem' }}>
            <dt style={{ fontWeight: 640 }}>Endpoint</dt>
            <dd style={{ margin: 0, wordBreak: 'break-all' }}>{api_.endpoint}</dd>
            <dt style={{ fontWeight: 640 }}>IP autorizada</dt>
            <dd style={{ margin: 0 }}>{api_.ip_autorizada ?? 'No registrada'}</dd>
            <dt style={{ fontWeight: 640 }}>Usuario del API</dt>
            <dd style={{ margin: 0 }}>{api_.usuario_api_enmascarado ?? 'No configurado'}</dd>
            <dt style={{ fontWeight: 640 }}>Credenciales</dt>
            <dd style={{ margin: 0 }}>
              {api_.credencialConfigurada ? (
                <span className="etiqueta etiqueta--verde">Presentes en el entorno seguro</span>
              ) : (
                <span className="etiqueta etiqueta--ambar">No configuradas</span>
              )}
              {api_.secreto_ref ? (
                <span style={{ marginLeft: '0.4rem', color: 'var(--texto-suave)' }}>
                  Referencia: <code>{api_.secreto_ref}</code>
                </span>
              ) : null}
            </dd>
            <dt style={{ fontWeight: 640 }}>Tiempo de espera / reintentos</dt>
            <dd style={{ margin: 0 }}>
              {api_.timeout_s} s · {api_.max_reintentos} reintento(s) con retroceso exponencial
            </dd>
            <dt style={{ fontWeight: 640 }}>Sincronizacion programada</dt>
            <dd style={{ margin: 0 }}>
              {api_.sync_programada ? `Activa a las ${api_.sync_hora ?? '02:30'} (America/Guatemala)` : 'Desactivada'}
            </dd>
            <dt style={{ fontWeight: 640 }}>Ultima prueba</dt>
            <dd style={{ margin: 0 }}>
              {fechaHora(api_.ultima_prueba)}
              {api_.resultado_ultima_prueba ? ` — ${api_.resultado_ultima_prueba}` : ''}
            </dd>
            <dt style={{ fontWeight: 640 }}>Ultima sincronizacion</dt>
            <dd style={{ margin: 0 }}>{fechaHora(api_.ultima_sincronizacion)}</dd>
          </dl>

          <MensajeInfo titulo="Las credenciales nunca se almacenan en la base de datos">
            El usuario y el <code>systemCode</code> viven unicamente como variables de entorno del
            servidor. La base de datos guarda solo una referencia al lugar donde residen.
          </MensajeInfo>
        </section>
      ))}

      {pasos.length > 0 ? (
        <section className="tarjeta">
          <h2>Pasos para activar la integracion real</h2>
          <ol style={{ fontSize: '0.88rem', lineHeight: 1.7, paddingLeft: '1.2rem' }}>
            {pasos.map((paso, indice) => (
              <li key={indice}>{paso}</li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="tarjeta">
        <div className="tarjeta__titulo">
          <h2>Historial de sincronizaciones</h2>
          <CampoSelect
            etiqueta="Estado"
            value={String(ejecuciones.estado.estado ?? '')}
            onChange={(e) => ejecuciones.actualizar({ estado: e.target.value })}
          >
            <option value="">Todos</option>
            <option value="COMPLETADA">Completadas</option>
            <option value="COMPLETADA_CON_ERRORES">Con errores</option>
            <option value="FALLIDA">Fallidas</option>
            <option value="EN_PROCESO">En proceso</option>
          </CampoSelect>
        </div>

        <Tabla<Ejecucion>
          titulo="Ejecuciones registradas"
          descripcion="Cada ejecucion guarda estado, duracion, rango consultado y filas procesadas."
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
            { clave: 'tipo', titulo: 'Tipo', render: (f) => textoEstado(f.tipo) },
            { clave: 'proyecto', titulo: 'Alcance', render: (f) => f.proyecto ?? 'Todos los proyectos' },
            {
              clave: 'rango',
              titulo: 'Rango consultado',
              render: (f) => `${fecha(f.rango_desde)} – ${fecha(f.rango_hasta)}`,
            },
            {
              clave: 'filas',
              titulo: 'Filas',
              numerica: true,
              render: (f) => `${f.filas_recibidas} rec. / ${f.insertadas} ins. / ${f.actualizadas} act. / ${f.rechazadas} rech.`,
            },
            {
              clave: 'duracion',
              titulo: 'Duracion',
              numerica: true,
              render: (f) => (f.duracion_ms === null ? '—' : `${numero(f.duracion_ms / 1000, 2)} s`),
            },
            {
              clave: 'mensaje',
              titulo: 'Resultado',
              render: (f) =>
                f.codigo_error ? (
                  <span>
                    <span className="etiqueta etiqueta--rojo">{f.codigo_error}</span> {f.mensaje}
                  </span>
                ) : (
                  f.mensaje ?? '—'
                ),
            },
            { clave: 'usuario', titulo: 'Usuario', render: (f) => f.usuario ?? 'Tarea programada' },
            { clave: 'fecha', titulo: 'Inicio', render: (f) => fechaHora(f.iniciada_en) },
          ]}
          filas={ejecuciones.filas}
          claveFila={(f) => f.id_sync}
          cargando={ejecuciones.cargando}
          error={ejecuciones.error}
          alReintentar={ejecuciones.recargar}
          vacioTitulo="Aun no se ha ejecutado ninguna sincronizacion"
          pie={ejecuciones.meta ? <Paginacion {...ejecuciones.meta} alCambiar={ejecuciones.irAPagina} /> : undefined}
        />
      </section>

      {/* --------------------------- Sincronizar --------------------------- */}
      {sincronizar ? (
        <Modal titulo="Ejecutar sincronizacion" alCerrar={() => setSincronizar(null)}>
          {error ? <MensajeError error={error} /> : null}
          <MensajeInfo>
            La sincronizacion es <strong>idempotente</strong>: repetir el mismo rango actualiza los registros
            existentes en lugar de duplicarlos. Un bloqueo impide ejecuciones simultaneas sobre el mismo
            alcance.
          </MensajeInfo>
          <div className="formulario">
            <CampoTexto
              etiqueta="Desde"
              type="date"
              obligatorio
              max={sincronizar.hasta}
              value={sincronizar.desde}
              onChange={(e) => setSincronizar({ ...sincronizar, desde: e.target.value })}
            />
            <CampoTexto
              etiqueta="Hasta"
              type="date"
              obligatorio
              min={sincronizar.desde}
              max={hoyISO()}
              value={sincronizar.hasta}
              onChange={(e) => setSincronizar({ ...sincronizar, hasta: e.target.value })}
            />
            <CampoSelect
              etiqueta="Granularidad"
              value={sincronizar.granularidad}
              onChange={(e) => setSincronizar({ ...sincronizar, granularidad: e.target.value })}
            >
              <option value="DIARIA">Diaria</option>
              <option value="MENSUAL">Mensual</option>
            </CampoSelect>
            <CampoSelect
              etiqueta="Proyecto"
              value={sincronizar.id_proyecto}
              ayuda="Vacio sincroniza todos los inversores Huawei de esta integracion."
              onChange={(e) => setSincronizar({ ...sincronizar, id_proyecto: e.target.value, id_inversor: '' })}
            >
              <option value="">Todos los proyectos</option>
              {catalogos.proyectos.map((p) => (
                <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
              ))}
            </CampoSelect>
            <CampoSelect
              etiqueta="Inversor"
              value={sincronizar.id_inversor}
              onChange={(e) => setSincronizar({ ...sincronizar, id_inversor: e.target.value })}
            >
              <option value="">Todos los inversores</option>
              {catalogos.inversores
                .filter(
                  (i) =>
                    i.tipo_conexion === 'HUAWEI_API' &&
                    (!sincronizar.id_proyecto || String(i.id_proyecto) === sincronizar.id_proyecto),
                )
                .map((i) => (
                  <option key={i.id_inversor} value={i.id_inversor}>
                    {i.marca} {i.modelo} ({i.serial_externo})
                  </option>
                ))}
            </CampoSelect>
          </div>
          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button type="button" className="boton boton--secundario" onClick={() => setSincronizar(null)}>
              Cancelar
            </button>
            <button type="button" className="boton" onClick={() => void ejecutarSync()} disabled={ocupado}>
              {ocupado ? 'Sincronizando...' : 'Iniciar sincronizacion'}
            </button>
          </div>
        </Modal>
      ) : null}

      {/* --------------------------- Resultado --------------------------- */}
      {resultado ? (
        <Modal titulo="Resultado de la sincronizacion" alCerrar={() => setResultado(null)}>
          {resultado.esSimulado ? (
            <MensajeAlerta titulo="Datos simulados">{resultado.etiquetaOrigen}</MensajeAlerta>
          ) : (
            <MensajeExito>{resultado.etiquetaOrigen}</MensajeExito>
          )}

          <section className="rejilla">
            <div className="indicador">
              <p className="indicador__etiqueta">Filas recibidas</p>
              <p className="indicador__valor">{resultado.filasRecibidas}</p>
            </div>
            <div className="indicador indicador--verde">
              <p className="indicador__etiqueta">Insertadas</p>
              <p className="indicador__valor">{resultado.insertadas}</p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Actualizadas</p>
              <p className="indicador__valor">{resultado.actualizadas}</p>
            </div>
            <div className={resultado.rechazadas > 0 ? 'indicador indicador--rojo' : 'indicador'}>
              <p className="indicador__etiqueta">Rechazadas</p>
              <p className="indicador__valor">{resultado.rechazadas}</p>
            </div>
          </section>

          <p style={{ fontSize: '0.87rem' }}>{resultado.mensaje}</p>
          <p style={{ fontSize: '0.82rem', color: 'var(--texto-suave)' }}>
            Duracion: {numero(resultado.duracionMs / 1000, 2)} s
          </p>

          {resultado.pendientesTarifa > 0 ? (
            <MensajeAlerta>
              {resultado.pendientesTarifa} registro(s) quedaron pendientes de tarifa. Registre la tarifa del
              mes correspondiente para completar su valorizacion.
            </MensajeAlerta>
          ) : null}

          {resultado.advertencias.length > 0 ? (
            <>
              <h3>Advertencias</h3>
              <ul style={{ fontSize: '0.85rem', paddingLeft: '1.1rem' }}>
                {resultado.advertencias.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          ) : null}

          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button type="button" className="boton" onClick={() => setResultado(null)}>
              Cerrar
            </button>
          </div>
        </Modal>
      ) : null}

      {/* --------------------------- Configurar --------------------------- */}
      {editar ? (
        <Confirmacion
          titulo="Configuracion de la integracion"
          textoConfirmar="Guardar configuracion"
          ocupado={ocupado}
          alConfirmar={() => void guardarConfig()}
          alCancelar={() => setEditar(null)}
          descripcion={
            <MensajeInfo>
              El modo <strong>REAL</strong> se conecta a la plataforma de Huawei con las credenciales
              configuradas en el entorno del servidor.
            </MensajeInfo>
          }
        >
          <div className="formulario" style={{ marginTop: '0.8rem' }}>
            <CampoTexto
              etiqueta="Nombre"
              value={editar.nombre}
              onChange={(e) => setEditar({ ...editar, nombre: e.target.value })}
            />
            <CampoTexto
              etiqueta="Endpoint del API"
              ancho
              value={editar.endpoint}
              onChange={(e) => setEditar({ ...editar, endpoint: e.target.value })}
            />
            <CampoTexto
              etiqueta="IP publica autorizada (opcional)"
              value={editar.ip_autorizada ?? ''}
              ayuda="No suele ser obligatoria para activar el modo real. Registrela solo si Huawei rechaza la conexion con el error 'IP no autorizada'."
              onChange={(e) => setEditar({ ...editar, ip_autorizada: e.target.value })}
            />
            <CampoTexto
              etiqueta="Usuario del API"
              value={editar.usuario_api ?? ''}
              ayuda="La contraseña o systemCode nunca se captura aqui: vive en el entorno del servicio."
              onChange={(e) => setEditar({ ...editar, usuario_api: e.target.value })}
            />
            <CampoSelect
              etiqueta="Modo"
              value={editar.modo}
              onChange={(e) => setEditar({ ...editar, modo: e.target.value as 'MOCK' | 'REAL' })}
            >
              <option value="MOCK">Simulado (sandbox)</option>
              <option value="REAL">Real (requiere autorizacion)</option>
            </CampoSelect>
            <CampoSelect
              etiqueta="Estado"
              value={editar.estado}
              onChange={(e) => setEditar({ ...editar, estado: e.target.value })}
            >
              <option value="ACTIVA">Activa</option>
              <option value="INACTIVA">Inactiva</option>
              <option value="PENDIENTE_AUTORIZACION">Pendiente de autorizacion</option>
            </CampoSelect>
            <CampoTexto
              etiqueta="Tiempo de espera (segundos)"
              type="number"
              min="5"
              max="300"
              value={editar.timeout_s}
              onChange={(e) => setEditar({ ...editar, timeout_s: Number(e.target.value) })}
            />
            <CampoTexto
              etiqueta="Reintentos maximos"
              type="number"
              min="0"
              max="10"
              value={editar.max_reintentos}
              onChange={(e) => setEditar({ ...editar, max_reintentos: Number(e.target.value) })}
            />
            <CampoTexto
              etiqueta="Hora de sincronizacion programada"
              type="time"
              value={editar.sync_hora ?? '02:30'}
              onChange={(e) => setEditar({ ...editar, sync_hora: e.target.value })}
            />
            <CampoCasilla
              etiqueta="Habilitar sincronizacion programada diaria"
              ancho
              checked={Boolean(editar.sync_programada)}
              onChange={(e) => setEditar({ ...editar, sync_programada: e.target.checked ? 1 : 0 })}
            />
          </div>
        </Confirmacion>
      ) : null}
    </>
  );
}
