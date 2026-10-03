import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, descargar } from '../lib/api';
import { useSesion } from '../lib/auth';
import { Cargando, MensajeError, MensajeExito, MensajeInfo } from '../components/Estados';
import { fechaHora } from '../lib/formato';

interface Parametro {
  clave: string;
  valor: string;
  tipo: 'TEXTO' | 'NUMERO' | 'BOOLEANO' | 'JSON';
  categoria: string;
  descripcion: string;
  unidad: string | null;
  fuente: string | null;
  editable: number;
  updated_at: string;
}

const TITULOS: Record<string, string> = {
  CARGAS: 'Cargas de archivos',
  SEGURIDAD: 'Seguridad y sesiones',
  INTEGRACION: 'Integracion y sincronizacion',
  AMBIENTAL: 'Factores de equivalencia ambiental',
  REPORTES: 'Reportes y formato',
  GENERAL: 'General',
};

function SeccionRespaldos() {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [confirmacion, setConfirmacion] = useState('');
  const [descargando, setDescargando] = useState(false);
  const [restaurando, setRestaurando] = useState(false);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const descargarCopia = async () => {
    setDescargando(true);
    setError(null);
    setExito(null);
    try {
      await descargar('/config/backup/download');
      setExito('Copia de respaldo descargada. Guardela en un lugar seguro y fuera de este servidor.');
    } catch (fallo) {
      setError(fallo);
    } finally {
      setDescargando(false);
    }
  };

  const restaurar = async () => {
    if (!archivo) return;
    setRestaurando(true);
    setError(null);
    setExito(null);
    try {
      const formulario = new FormData();
      formulario.append('archivo', archivo);
      formulario.append('confirmacion', confirmacion);
      const respuesta = await api.subir<{ mensaje: string }>('/config/backup/restore', formulario);
      setExito(respuesta.datos.mensaje);
      setArchivo(null);
      setConfirmacion('');
      window.setTimeout(() => window.location.assign('/ingresar'), 3500);
    } catch (fallo) {
      setError(fallo);
    } finally {
      setRestaurando(false);
    }
  };

  return (
    <section className="tarjeta" aria-labelledby="titulo-respaldos">
      <h2 id="titulo-respaldos">Respaldos</h2>
      <p style={{ fontSize: '0.88rem' }}>
        Descargue una copia completa de los datos del sistema (clientes, proyectos, inversores, produccion,
        tarifas, proyecciones, usuarios y configuracion) o restaure una copia generada anteriormente.
      </p>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error ? <MensajeError error={error} /> : null}

      <h3 style={{ marginTop: '1rem' }}>Descargar una copia</h3>
      <p style={{ fontSize: '0.84rem', color: 'var(--texto-suave)' }}>
        El archivo contiene informacion sensible, incluidas las contraseñas cifradas de los usuarios:
        guardelo en un lugar seguro. No incluye las sesiones activas ni los archivos originales cargados.
      </p>
      <button type="button" className="boton" disabled={descargando} onClick={() => void descargarCopia()}>
        {descargando ? 'Generando copia...' : 'Descargar copia de respaldo'}
      </button>

      <h3 style={{ marginTop: '1.6rem' }}>Restaurar desde un respaldo</h3>
      <MensajeInfo>
        Esta accion <strong>reemplaza todos los datos actuales</strong> por los del archivo. Antes de
        hacerlo el sistema guarda automaticamente una copia previa en el servidor. Al terminar tendra que
        iniciar sesion de nuevo. Solo se aceptan respaldos generados por este sistema y con la misma
        version de estructura de datos.
      </MensajeInfo>

      <div style={{ display: 'grid', gap: '0.7rem', maxWidth: '460px', marginTop: '0.7rem' }}>
        <label>
          Archivo de respaldo (.json)
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          Escriba <strong>RESTAURAR</strong> para confirmar
          <input
            type="text"
            autoComplete="off"
            value={confirmacion}
            onChange={(e) => setConfirmacion(e.target.value)}
          />
        </label>
        <div>
          <button
            type="button"
            className="boton boton--peligro"
            disabled={!archivo || confirmacion !== 'RESTAURAR' || restaurando}
            onClick={() => void restaurar()}
          >
            {restaurando ? 'Restaurando...' : 'Restaurar respaldo'}
          </button>
        </div>
      </div>
    </section>
  );
}

export function PaginaConfiguracion() {
  const { puede } = useSesion();
  const [edicion, setEdicion] = useState<Record<string, string>>({});
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [guardando, setGuardando] = useState<string | null>(null);

  const gestionar = puede('config.gestionar');

  const consulta = useQuery({
    queryKey: ['configuracion'],
    queryFn: async () => (await api.obtener<Parametro[]>('/config')).datos,
  });

  const guardar = async (parametro: Parametro) => {
    const valor = edicion[parametro.clave];
    if (valor === undefined) return;
    setGuardando(parametro.clave);
    setError(null);
    try {
      await api.actualizar(`/config/${parametro.clave}`, { valor });
      setExito(`Parametro "${parametro.clave}" actualizado correctamente.`);
      setEdicion((actual) => {
        const siguiente = { ...actual };
        delete siguiente[parametro.clave];
        return siguiente;
      });
      void consulta.refetch();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setGuardando(null);
    }
  };

  const porCategoria = (consulta.data ?? []).reduce<Record<string, Parametro[]>>((acc, parametro) => {
    (acc[parametro.categoria] ??= []).push(parametro);
    return acc;
  }, {});

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Configuracion del sistema</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Parametros operativos y factores de conversion. Ningun valor de negocio queda como constante
            oculta en el codigo.
          </p>
        </div>
      </div>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error ? <MensajeError error={error} /> : null}

      {!gestionar ? (
        <MensajeInfo>
          Su rol permite consultar los parametros pero no modificarlos. Solicite el cambio a un usuario
          administrativo.
        </MensajeInfo>
      ) : null}

      {gestionar ? <SeccionRespaldos /> : null}

      {consulta.isLoading ? <Cargando /> : null}
      {consulta.error ? <MensajeError error={consulta.error} alReintentar={() => void consulta.refetch()} /> : null}

      {Object.entries(porCategoria).map(([categoria, parametros]) => (
        <section className="tarjeta" key={categoria}>
          <h2>{TITULOS[categoria] ?? categoria}</h2>

          {categoria === 'AMBIENTAL' ? (
            <MensajeInfo>
              Estos factores alimentan las tarjetas de equivalencia ambiental del tablero. Cada uno declara
              su <strong>unidad</strong> y su <strong>fuente</strong>; ajustelos al valor oficial vigente que
              adopte Retse, S.A.
            </MensajeInfo>
          ) : null}

          <div className="tabla-envoltura">
            <table>
              <caption>Parametros de {TITULOS[categoria] ?? categoria}.</caption>
              <thead>
                <tr>
                  <th scope="col">Parametro</th>
                  <th scope="col">Descripcion</th>
                  <th scope="col">Valor</th>
                  <th scope="col">Unidad</th>
                  <th scope="col">Fuente</th>
                  <th scope="col">Ultima modificacion</th>
                  {gestionar ? <th scope="col" className="no-imprimir">Accion</th> : null}
                </tr>
              </thead>
              <tbody>
                {parametros.map((parametro) => {
                  const enEdicion = edicion[parametro.clave] !== undefined;
                  return (
                    <tr key={parametro.clave}>
                      <th scope="row" style={{ position: 'static', background: 'transparent' }}>
                        <code>{parametro.clave}</code>
                      </th>
                      <td>{parametro.descripcion}</td>
                      <td>
                        {gestionar && parametro.editable ? (
                          parametro.tipo === 'BOOLEANO' ? (
                            <select
                              aria-label={`Valor de ${parametro.clave}`}
                              value={enEdicion ? edicion[parametro.clave] : parametro.valor}
                              onChange={(e) => setEdicion({ ...edicion, [parametro.clave]: e.target.value })}
                            >
                              <option value="true">Activado</option>
                              <option value="false">Desactivado</option>
                            </select>
                          ) : (
                            <input
                              aria-label={`Valor de ${parametro.clave}`}
                              type={parametro.tipo === 'NUMERO' ? 'number' : 'text'}
                              step="any"
                              value={enEdicion ? edicion[parametro.clave] : parametro.valor}
                              onChange={(e) => setEdicion({ ...edicion, [parametro.clave]: e.target.value })}
                              style={{ width: '100%', minWidth: '120px' }}
                            />
                          )
                        ) : (
                          <strong>{parametro.valor}</strong>
                        )}
                      </td>
                      <td>{parametro.unidad ?? '—'}</td>
                      <td style={{ fontSize: '0.8rem', maxWidth: '280px' }}>{parametro.fuente ?? '—'}</td>
                      <td>{fechaHora(parametro.updated_at)}</td>
                      {gestionar ? (
                        <td className="no-imprimir">
                          {parametro.editable ? (
                            <button
                              type="button"
                              className="boton boton--pequeno"
                              disabled={!enEdicion || guardando === parametro.clave}
                              onClick={() => void guardar(parametro)}
                            >
                              {guardando === parametro.clave ? 'Guardando...' : 'Guardar'}
                            </button>
                          ) : (
                            <span className="etiqueta etiqueta--gris">Fijo</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
