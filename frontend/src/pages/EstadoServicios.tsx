import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Cargando, MensajeAlerta, MensajeError, MensajeExito } from '../components/Estados';
import { fechaHora, numero, textoEstado, claseEstado } from '../lib/formato';

interface Salud {
  api: {
    estado: string;
    version: string;
    entorno: string;
    uptimeSegundos: number;
    memoriaMb: number;
    nodo: string;
    host: string;
  };
  mysql: { estado: string; base: string; tablas: number; tamanoMb: number };
  servicioPython: { estado: string; url: string; version: string | null; modo: string | null };
  integracionHuawei: { modo: string; simulado: boolean; ipAutorizada: string };
  tareaProgramada: { habilitada: boolean; horario: string; ultimaEjecucion: string | null };
  ultimaSincronizacion: { id_sync: number; estado: string; modo: string; iniciada_en: string; mensaje: string | null } | null;
  ultimaImportacion: { id_historico: number; estado: string; created_at: string } | null;
  zonaHoraria: string;
  horaLocal: string;
}

function Semaforo({ estado }: { estado: string }) {
  const operativo = estado === 'operativo';
  return (
    <span className={operativo ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--rojo'}>
      {operativo ? 'Operativo' : 'No disponible'}
    </span>
  );
}

export function PaginaEstado() {
  const consulta = useQuery({
    queryKey: ['salud-detalle'],
    refetchInterval: 30_000,
    queryFn: async () => (await api.obtener<Salud>('/health/detalle')).datos,
  });

  const datos = consulta.data;

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Estado de los servicios</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Monitoreo basico de la API, MySQL, el servicio Python de integracion y las tareas programadas.
            Se actualiza automaticamente cada 30 segundos.
          </p>
        </div>
        <button type="button" className="boton boton--secundario no-imprimir" onClick={() => void consulta.refetch()}>
          Actualizar ahora
        </button>
      </div>

      {consulta.isLoading ? <Cargando mensaje="Consultando el estado de los servicios..." /> : null}
      {consulta.error ? <MensajeError error={consulta.error} alReintentar={() => void consulta.refetch()} /> : null}

      {datos ? (
        <>
          {datos.mysql.estado === 'operativo' && datos.servicioPython.estado === 'operativo' ? (
            <MensajeExito>Todos los servicios responden correctamente.</MensajeExito>
          ) : (
            <MensajeAlerta titulo="Hay servicios degradados">
              {datos.mysql.estado !== 'operativo' ? 'MySQL no responde. ' : ''}
              {datos.servicioPython.estado !== 'operativo'
                ? 'El servicio Python de integracion no responde: la sincronizacion Huawei no estara disponible. '
                : ''}
              Revise los registros del servidor y el estado de los procesos.
            </MensajeAlerta>
          )}

          <section className="rejilla">
            <div className="indicador">
              <p className="indicador__etiqueta">API Node.js</p>
              <p className="indicador__valor" style={{ fontSize: '1.1rem' }}>
                <Semaforo estado={datos.api.estado} />
              </p>
              <p className="indicador__detalle">
                v{datos.api.version} · {datos.api.entorno} · {datos.api.nodo}
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Base de datos MySQL</p>
              <p className="indicador__valor" style={{ fontSize: '1.1rem' }}>
                <Semaforo estado={datos.mysql.estado} />
              </p>
              <p className="indicador__detalle">
                {datos.mysql.base} · {datos.mysql.tablas} tablas · {numero(datos.mysql.tamanoMb, 2)} MB
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Servicio Python</p>
              <p className="indicador__valor" style={{ fontSize: '1.1rem' }}>
                <Semaforo estado={datos.servicioPython.estado} />
              </p>
              <p className="indicador__detalle">
                {datos.servicioPython.url} · modo {textoEstado(datos.servicioPython.modo)}
              </p>
            </div>
            <div className={datos.integracionHuawei.simulado ? 'indicador indicador--ambar' : 'indicador indicador--verde'}>
              <p className="indicador__etiqueta">Integracion Huawei</p>
              <p className="indicador__valor" style={{ fontSize: '1.1rem' }}>
                {datos.integracionHuawei.simulado ? 'Modo simulado' : 'Modo real'}
              </p>
              <p className="indicador__detalle">IP autorizada: {datos.integracionHuawei.ipAutorizada}</p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Tiempo en linea</p>
              <p className="indicador__valor">{numero(datos.api.uptimeSegundos / 3600, 1)} h</p>
              <p className="indicador__detalle">Memoria: {datos.api.memoriaMb} MB · Host: {datos.api.host}</p>
            </div>
            <div className={datos.tareaProgramada.habilitada ? 'indicador indicador--verde' : 'indicador'}>
              <p className="indicador__etiqueta">Tarea programada</p>
              <p className="indicador__valor" style={{ fontSize: '1.1rem' }}>
                {datos.tareaProgramada.habilitada ? 'Habilitada' : 'Deshabilitada'}
              </p>
              <p className="indicador__detalle">
                Horario {datos.tareaProgramada.horario} · Ultima ejecucion:{' '}
                {fechaHora(datos.tareaProgramada.ultimaEjecucion)}
              </p>
            </div>
          </section>

          <section className="tarjeta">
            <h2>Ultimas operaciones de datos</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.4rem 1rem', fontSize: '0.88rem' }}>
              <dt style={{ fontWeight: 640 }}>Ultima sincronizacion</dt>
              <dd style={{ margin: 0 }}>
                {datos.ultimaSincronizacion ? (
                  <>
                    <span className={claseEstado(datos.ultimaSincronizacion.estado)}>
                      {textoEstado(datos.ultimaSincronizacion.estado)}
                    </span>{' '}
                    {datos.ultimaSincronizacion.modo === 'MOCK' ? (
                      <span className="etiqueta etiqueta--azul">Simulada</span>
                    ) : null}{' '}
                    · {fechaHora(datos.ultimaSincronizacion.iniciada_en)}
                    {datos.ultimaSincronizacion.mensaje ? ` — ${datos.ultimaSincronizacion.mensaje}` : ''}
                  </>
                ) : (
                  'Sin ejecuciones registradas'
                )}
              </dd>
              <dt style={{ fontWeight: 640 }}>Ultima importacion</dt>
              <dd style={{ margin: 0 }}>
                {datos.ultimaImportacion ? (
                  <>
                    <span className={claseEstado(datos.ultimaImportacion.estado)}>
                      {textoEstado(datos.ultimaImportacion.estado)}
                    </span>{' '}
                    · {fechaHora(datos.ultimaImportacion.created_at)}
                  </>
                ) : (
                  'Sin importaciones registradas'
                )}
              </dd>
              <dt style={{ fontWeight: 640 }}>Zona horaria</dt>
              <dd style={{ margin: 0 }}>{datos.zonaHoraria}</dd>
              <dt style={{ fontWeight: 640 }}>Hora local del servidor</dt>
              <dd style={{ margin: 0 }}>{datos.horaLocal}</dd>
            </dl>
          </section>
        </>
      ) : null}
    </>
  );
}
