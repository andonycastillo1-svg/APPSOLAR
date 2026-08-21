import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
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
