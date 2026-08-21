import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { numero } from '../lib/formato';

/**
 * Graficas del sistema.
 * Cada grafica incluye una ALTERNATIVA TEXTUAL en forma de tabla desplegable
 * (WCAG 2.2 AA, criterio 1.1.1): la informacion nunca depende solo del color.
 */

const COLORES = ['#0b3c5d', '#1e8449', '#b7791f', '#14567f', '#7d3c98', '#c0392b', '#117a65', '#8a5a00'];

interface SerieDato {
  etiqueta: string;
  kwh: number;
  valor_q: number;
}

function AlternativaTextual({
  resumen,
  cabeceras,
  filas,
}: {
  resumen: string;
  cabeceras: string[];
  filas: string[][];
}) {
  return (
    <details className="tabla-alternativa">
      <summary>Ver los datos de la grafica en forma de tabla</summary>
      <p style={{ marginTop: '0.5rem' }}>{resumen}</p>
      <div className="tabla-envoltura">
        <table>
          <thead>
            <tr>
              {cabeceras.map((cabecera) => (
                <th key={cabecera} scope="col">
                  {cabecera}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((fila, indice) => (
              <tr key={indice}>
                {fila.map((celda, columna) => (
                  <td key={columna} className={columna > 0 ? 'num' : undefined}>
                    {celda}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function GraficaSerie({ datos, titulo }: { datos: SerieDato[]; titulo: string }) {
  if (datos.length === 0) {
    return <p className="estado">No hay datos de produccion en el periodo seleccionado.</p>;
  }

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="solo-lectores">
        {titulo}. Grafica de barras de energia generada en kWh por periodo. Los mismos datos estan
        disponibles en la tabla que sigue.
      </figcaption>
      <div className="grafica" role="img" aria-label={`${titulo}: ${datos.length} periodo(s) representados`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={datos} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e3e9ed" />
            <XAxis dataKey="etiqueta" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => numero(v, 0)} width={78} />
            <Tooltip
              formatter={(valor: number, nombre: string) =>
                nombre === 'Valor (Q)' ? `Q ${numero(valor)}` : `${numero(valor)} kWh`
              }
              labelStyle={{ fontWeight: 600 }}
            />
            <Legend />
            <Bar dataKey="kwh" name="Generacion (kWh)" fill="#0b3c5d" radius={[3, 3, 0, 0]} />
            <Line dataKey="valor_q" name="Valor (Q)" stroke="#b7791f" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <AlternativaTextual
        resumen={`${titulo}: ${datos.length} periodo(s).`}
        cabeceras={['Periodo', 'Generacion (kWh)', 'Valor (Q)']}
        filas={datos.map((d) => [d.etiqueta, numero(d.kwh), numero(d.valor_q)])}
      />
    </figure>
  );
}

export interface FilaComparativa {
  mesNombre: string;
  proyeccion_kwh: number | null;
  generacion_anio_anterior: number;
  generacion_anio_seleccionado: number;
}

export function GraficaComparativa({
  filas,
  anio,
}: {
  filas: FilaComparativa[];
  anio: number;
}) {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="solo-lectores">
        Comparacion mensual entre proyeccion, generacion del anio {anio - 1} y generacion del anio {anio}.
      </figcaption>
      <div
        className="grafica grafica--alta"
        role="img"
        aria-label={`Comparacion mensual de proyeccion, ${anio - 1} y ${anio}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={filas} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e3e9ed" />
            <XAxis dataKey="mesNombre" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => numero(v, 0)} width={82} />
            <Tooltip formatter={(valor: number) => `${numero(valor)} kWh`} />
            <Legend />
            <Bar dataKey="generacion_anio_anterior" name={`Generacion ${anio - 1}`} fill="#9aa6ae" radius={[3, 3, 0, 0]} />
            <Bar dataKey="generacion_anio_seleccionado" name={`Generacion ${anio}`} fill="#1e8449" radius={[3, 3, 0, 0]} />
            <Line
              dataKey="proyeccion_kwh"
              name="Proyeccion"
              stroke="#b7791f"
              strokeWidth={2.5}
              strokeDasharray="6 3"
              dot={{ r: 3 }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <AlternativaTextual
        resumen={`Comparacion mensual de proyeccion, generacion ${anio - 1} y generacion ${anio}, en kWh.`}
        cabeceras={['Mes', 'Proyeccion (kWh)', `Generacion ${anio - 1} (kWh)`, `Generacion ${anio} (kWh)`]}
        filas={filas.map((f) => [
          f.mesNombre,
          f.proyeccion_kwh === null ? 'Sin proyeccion' : numero(f.proyeccion_kwh),
          numero(f.generacion_anio_anterior),
          numero(f.generacion_anio_seleccionado),
        ])}
      />
    </figure>
  );
}

export function GraficaDistribucion({
  datos,
}: {
  datos: Array<{ proyecto: string; kwh: number; valor_q: number }>;
}) {
  if (datos.length === 0) {
    return <p className="estado">No hay produccion registrada para distribuir.</p>;
  }

  const total = datos.reduce((acc, d) => acc + d.kwh, 0);

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="solo-lectores">
        Distribucion de la produccion por proyecto en el periodo seleccionado.
      </figcaption>
      <div className="grafica" role="img" aria-label="Distribucion de produccion por proyecto">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={datos}
              dataKey="kwh"
              nameKey="proyecto"
              cx="50%"
              cy="50%"
              outerRadius="78%"
              label={(entrada: { proyecto?: string; percent?: number }) =>
                `${entrada.proyecto ?? ''}: ${numero((entrada.percent ?? 0) * 100, 1)}%`
              }
              labelLine={false}
            >
              {datos.map((_, indice) => (
                <Cell key={indice} fill={COLORES[indice % COLORES.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(valor: number) => `${numero(valor)} kWh`} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <AlternativaTextual
        resumen={`Distribucion de ${numero(total)} kWh entre ${datos.length} proyecto(s).`}
        cabeceras={['Proyecto', 'Generacion (kWh)', 'Participacion', 'Valor (Q)']}
        filas={datos.map((d) => [
          d.proyecto,
          numero(d.kwh),
          `${numero(total > 0 ? (d.kwh / total) * 100 : 0, 1)} %`,
          numero(d.valor_q),
        ])}
      />
    </figure>
  );
}

export function GraficaBarrasComparacion({
  datos,
  etiquetaValor = 'kWh',
}: {
  datos: Array<{ nombre: string; valor: number }>;
  etiquetaValor?: string;
}) {
  if (datos.length === 0) {
    return <p className="estado">No hay elementos comparables en el periodo seleccionado.</p>;
  }

  return (
    <figure style={{ margin: 0 }}>
      <div className="grafica" role="img" aria-label={`Comparacion por ${etiquetaValor}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={datos} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e3e9ed" />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => numero(v, 0)} />
            <YAxis type="category" dataKey="nombre" tick={{ fontSize: 11 }} width={185} />
            <Tooltip formatter={(valor: number) => `${numero(valor)} ${etiquetaValor}`} />
            <Bar dataKey="valor" name={etiquetaValor} fill="#14567f" radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <AlternativaTextual
        resumen={`Comparacion de ${datos.length} elemento(s) por ${etiquetaValor}.`}
        cabeceras={['Elemento', etiquetaValor]}
        filas={datos.map((d) => [d.nombre, numero(d.valor)])}
      />
    </figure>
  );
}
