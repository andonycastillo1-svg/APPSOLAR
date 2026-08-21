import type { ReactNode } from 'react';
import { Cargando, MensajeError, Vacio } from './Estados';

export interface Columna<T> {
  clave: string;
  titulo: string;
  /** Campo por el que ordena el servidor. Si falta, la columna no es ordenable. */
  orden?: string;
  numerica?: boolean;
  render: (fila: T) => ReactNode;
  /** Texto plano usado por lectores de pantalla cuando el render es visual. */
  textoAccesible?: (fila: T) => string;
}

interface Props<T> {
  titulo?: string;
  descripcion?: string;
  columnas: Array<Columna<T>>;
  filas: T[] | undefined;
  claveFila: (fila: T) => string | number;
  cargando?: boolean;
  error?: unknown;
  alReintentar?: () => void;
  vacioTitulo?: string;
  vacioDescripcion?: string;
  accionVacio?: ReactNode;
  ordenActual?: string;
  direccionActual?: 'asc' | 'desc';
  alOrdenar?: (campo: string, direccion: 'asc' | 'desc') => void;
  pie?: ReactNode;
}

/** Tabla accesible con ordenamiento en servidor y estados completos. */
export function Tabla<T>({
  titulo,
  descripcion,
  columnas,
  filas,
  claveFila,
  cargando,
  error,
  alReintentar,
  vacioTitulo,
  vacioDescripcion,
  accionVacio,
  ordenActual,
  direccionActual,
  alOrdenar,
  pie,
}: Props<T>) {
  if (error) return <MensajeError error={error} alReintentar={alReintentar} />;
  if (cargando) return <Cargando />;
  if (!filas || filas.length === 0) {
    return <Vacio titulo={vacioTitulo} descripcion={vacioDescripcion} accion={accionVacio} />;
  }

  return (
    <>
      <div className="tabla-envoltura">
        <table>
          {titulo || descripcion ? (
            <caption>
              {titulo ? <strong>{titulo}. </strong> : null}
              {descripcion}
            </caption>
          ) : null}
          <thead>
            <tr>
              {columnas.map((columna) => {
                const esOrdenActual = alOrdenar && columna.orden && ordenActual === columna.orden;
                const ordenAria = esOrdenActual
                  ? direccionActual === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : columna.orden && alOrdenar
                    ? 'none'
                    : undefined;
                return (
                  <th
                    key={columna.clave}
                    scope="col"
                    aria-sort={ordenAria}
                    className={columna.numerica ? 'num' : undefined}
                  >
                    {columna.orden && alOrdenar ? (
                      <button
                        type="button"
                        onClick={() =>
                          alOrdenar(
                            columna.orden!,
                            esOrdenActual && direccionActual === 'asc' ? 'desc' : 'asc',
                          )
                        }
                      >
                        {columna.titulo}
                        <span aria-hidden="true">
                          {esOrdenActual ? (direccionActual === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                        <span className="solo-lectores">
                          {esOrdenActual
                            ? `, ordenado ${direccionActual === 'asc' ? 'ascendente' : 'descendente'}`
                            : ', activar para ordenar'}
                        </span>
                      </button>
                    ) : (
                      columna.titulo
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filas.map((fila) => (
              <tr key={claveFila(fila)}>
                {columnas.map((columna) => (
                  <td key={columna.clave} className={columna.numerica ? 'num' : undefined}>
                    {columna.render(fila)}
                    {columna.textoAccesible ? (
                      <span className="solo-lectores">{columna.textoAccesible(fila)}</span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pie}
    </>
  );
}

export function Paginacion({
  pagina,
  porPagina,
  total,
  totalPaginas,
  alCambiar,
}: {
  pagina: number;
  porPagina: number;
  total: number;
  totalPaginas: number;
  alCambiar: (pagina: number) => void;
}) {
  const desde = total === 0 ? 0 : (pagina - 1) * porPagina + 1;
  const hasta = Math.min(pagina * porPagina, total);

  return (
    <nav className="paginacion no-imprimir" aria-label="Paginacion de resultados">
      <span aria-live="polite">
        Mostrando {desde}–{hasta} de {total} registro(s)
      </span>
      <div className="acciones">
        <button
          type="button"
          className="boton boton--secundario boton--pequeno"
          onClick={() => alCambiar(pagina - 1)}
          disabled={pagina <= 1}
        >
          Anterior
        </button>
        <span>
          Pagina {pagina} de {totalPaginas}
        </span>
        <button
          type="button"
          className="boton boton--secundario boton--pequeno"
          onClick={() => alCambiar(pagina + 1)}
          disabled={pagina >= totalPaginas}
        >
          Siguiente
        </button>
      </div>
    </nav>
  );
}
