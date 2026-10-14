import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  ReferenceLine,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from 'recharts';
import { numero } from '../lib/formato';
import { PALETAS, useTema } from '../lib/tema';

/**
 * Graficas del sistema.
 *
 * - Todas se animan al aparecer y al cambiar de datos; la animacion se apaga
 *   sola si la persona pidio "reducir movimiento" (ver `useAnimar`).
 * - Cada grafica incluye una ALTERNATIVA TEXTUAL en forma de tabla desplegable
 *   (WCAG 2.2 AA, criterio 1.1.1): la informacion nunca depende solo del color.
 * - Los colores salen de la paleta del tema activo (claro / oscuro).
 */

const DURACION = 900;

/** Verdadero salvo que la persona haya pedido reducir el movimiento. */
function useAnimar(): boolean {
  return useMemo(() => {
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return true;
    }
  }, []);
}

function usePaleta() {
  return PALETAS[useTema()];
}

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

/** Selector segmentado para elegir el tipo de grafica. */
export function SelectorTipo<T extends string>({
  valor,
  opciones,
  alCambiar,
  etiqueta,
}: {
  valor: T;
  opciones: Array<{ valor: T; texto: string }>;
  alCambiar: (valor: T) => void;
  etiqueta: string;
}) {
  return (
    <div className="segmentos no-imprimir" role="group" aria-label={etiqueta}>
      {opciones.map((opcion) => (
        <button
          key={opcion.valor}
          type="button"
          aria-pressed={valor === opcion.valor}
          onClick={() => alCambiar(opcion.valor)}
        >
          {opcion.texto}
        </button>
      ))}
    </div>
  );
}

function Cabecera({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Serie temporal: barras, lineas, area o acumulado
// ---------------------------------------------------------------------------

type TipoSerie = 'barras' | 'lineas' | 'area' | 'acumulado';

export function GraficaSerie({
  datos,
  titulo,
  tipoInicial = 'barras',
}: {
  datos: SerieDato[];
  titulo: string;
  tipoInicial?: TipoSerie;
}) {
  const [tipo, setTipo] = useState<TipoSerie>(tipoInicial);
  const paleta = usePaleta();
  const animar = useAnimar();
  const idDegradado = useId().replace(/:/g, '');

  const conAcumulado = useMemo(() => {
    let suma = 0;
    let sumaQ = 0;
    return datos.map((d) => {
      suma += d.kwh;
      sumaQ += d.valor_q;
      return { ...d, acumulado_kwh: suma, acumulado_q: sumaQ };
    });
  }, [datos]);

  if (datos.length === 0) {
    return <p className="estado">No hay datos de produccion en el periodo seleccionado.</p>;
  }

  const color = paleta.serie[0];
  const colorQ = paleta.serie[2];
  const ejes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={paleta.rejilla} vertical={false} />
      <XAxis dataKey="etiqueta" tick={{ fontSize: 11, fill: paleta.texto }} interval="preserveStartEnd" tickLine={false} />
      <YAxis
        tick={{ fontSize: 11, fill: paleta.texto }}
        tickFormatter={(v) => numero(v, 0)}
        width={78}
        tickLine={false}
        axisLine={false}
      />
      <Tooltip
        formatter={(valor: number, nombre: string) =>
          nombre.includes('(Q)') ? `Q ${numero(valor)}` : `${numero(valor)} kWh`
        }
        labelStyle={{ fontWeight: 600 }}
      />
      <Legend />
      <defs>
        <linearGradient id={idDegradado} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.55} />
          <stop offset="100%" stopColor={color} stopOpacity={0.03} />
        </linearGradient>
      </defs>
    </>
  );

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="solo-lectores">
        {titulo}. Grafica de energia generada en kWh por periodo. Los mismos datos estan disponibles
        en la tabla que sigue.
      </figcaption>
      <Cabecera>
        <SelectorTipo<TipoSerie>
          etiqueta="Tipo de grafica"
          valor={tipo}
          alCambiar={setTipo}
          opciones={[
            { valor: 'barras', texto: 'Barras' },
            { valor: 'lineas', texto: 'Lineas' },
            { valor: 'area', texto: 'Area' },
            { valor: 'acumulado', texto: 'Acumulado' },
          ]}
        />
      </Cabecera>
      <div className="grafica" role="img" aria-label={`${titulo}: ${datos.length} periodo(s) representados`}>
        <ResponsiveContainer width="100%" height="100%">
          {tipo === 'barras' ? (
            <ComposedChart data={datos} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Bar
                dataKey="kwh"
                name="Generacion (kWh)"
                fill={color}
                radius={[6, 6, 0, 0]}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
              <Line
                dataKey="valor_q"
                name="Valor (Q)"
                stroke={colorQ}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
            </ComposedChart>
          ) : tipo === 'lineas' ? (
            <LineChart data={datos} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Line
                dataKey="kwh"
                name="Generacion (kWh)"
                stroke={color}
                strokeWidth={3}
                type="monotone"
                dot={{ r: 3 }}
                activeDot={{ r: 6 }}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
              <Line
                dataKey="valor_q"
                name="Valor (Q)"
                stroke={colorQ}
                strokeWidth={2}
                type="monotone"
                dot={false}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
            </LineChart>
          ) : tipo === 'area' ? (
            <AreaChart data={datos} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Area
                dataKey="kwh"
                name="Generacion (kWh)"
                type="monotone"
                stroke={color}
                strokeWidth={2.5}
                fill={`url(#${idDegradado})`}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
            </AreaChart>
          ) : (
            <AreaChart data={conAcumulado} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Area
                dataKey="acumulado_kwh"
                name="Generacion acumulada (kWh)"
                type="monotone"
                stroke={color}
                strokeWidth={2.5}
                fill={`url(#${idDegradado})`}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
      <AlternativaTextual
        resumen={`${titulo}: ${datos.length} periodo(s).`}
        cabeceras={['Periodo', 'Generacion (kWh)', 'Acumulado (kWh)', 'Valor (Q)']}
        filas={conAcumulado.map((d) => [d.etiqueta, numero(d.kwh), numero(d.acumulado_kwh), numero(d.valor_q)])}
      />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Comparativa anual
// ---------------------------------------------------------------------------

export interface FilaComparativa {
  mesNombre: string;
  proyeccion_kwh: number | null;
  generacion_anio_anterior: number;
  generacion_anio_seleccionado: number;
}

export function GraficaComparativa({ filas, anio }: { filas: FilaComparativa[]; anio: number }) {
  const [tipo, setTipo] = useState<'barras' | 'lineas'>('barras');
  const paleta = usePaleta();
  const animar = useAnimar();

  const ejes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={paleta.rejilla} vertical={false} />
      <XAxis dataKey="mesNombre" tick={{ fontSize: 11, fill: paleta.texto }} tickLine={false} />
      <YAxis
        tick={{ fontSize: 11, fill: paleta.texto }}
        tickFormatter={(v) => numero(v, 0)}
        width={82}
        tickLine={false}
        axisLine={false}
      />
      <Tooltip formatter={(valor: number) => `${numero(valor)} kWh`} />
      <Legend />
    </>
  );

  const proyeccion = (
    <Line
      dataKey="proyeccion_kwh"
      name="Proyeccion"
      stroke={paleta.serie[2]}
      strokeWidth={2.5}
      strokeDasharray="6 3"
      dot={{ r: 3 }}
      connectNulls
      isAnimationActive={animar}
      animationDuration={DURACION}
    />
  );

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="solo-lectores">
        Comparacion mensual entre proyeccion, generacion del anio {anio - 1} y generacion del anio {anio}.
      </figcaption>
      <Cabecera>
        <SelectorTipo<'barras' | 'lineas'>
          etiqueta="Tipo de grafica"
          valor={tipo}
          alCambiar={setTipo}
          opciones={[
            { valor: 'barras', texto: 'Barras' },
            { valor: 'lineas', texto: 'Lineas' },
          ]}
        />
      </Cabecera>
      <div
        className="grafica grafica--alta"
        role="img"
        aria-label={`Comparacion mensual de proyeccion, ${anio - 1} y ${anio}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          {tipo === 'barras' ? (
            <ComposedChart data={filas} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Bar
                dataKey="generacion_anio_anterior"
                name={`Generacion ${anio - 1}`}
                fill={paleta.serie[7]}
                radius={[6, 6, 0, 0]}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
              <Bar
                dataKey="generacion_anio_seleccionado"
                name={`Generacion ${anio}`}
                fill={paleta.serie[1]}
                radius={[6, 6, 0, 0]}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
              {proyeccion}
            </ComposedChart>
          ) : (
            <LineChart data={filas} margin={{ top: 12, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Line
                dataKey="generacion_anio_anterior"
                name={`Generacion ${anio - 1}`}
                stroke={paleta.serie[7]}
                strokeWidth={2.5}
                type="monotone"
                dot={false}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
              <Line
                dataKey="generacion_anio_seleccionado"
                name={`Generacion ${anio}`}
                stroke={paleta.serie[1]}
                strokeWidth={3}
                type="monotone"
                dot={{ r: 3 }}
                isAnimationActive={animar}
                animationDuration={DURACION}
              />
              {proyeccion}
            </LineChart>
          )}
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

// ---------------------------------------------------------------------------
// Distribucion: dona, pastel o barras
// ---------------------------------------------------------------------------

export function GraficaDistribucion({
  datos,
}: {
  datos: Array<{ proyecto: string; kwh: number; valor_q: number }>;
}) {
  const [tipo, setTipo] = useState<'dona' | 'pastel' | 'barras'>('dona');
  const paleta = usePaleta();
  const animar = useAnimar();

  if (datos.length === 0) {
    return <p className="estado">No hay produccion registrada para distribuir.</p>;
  }

  const total = datos.reduce((acc, d) => acc + d.kwh, 0);

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="solo-lectores">
        Distribucion de la produccion por proyecto en el periodo seleccionado.
      </figcaption>
      <Cabecera>
        <SelectorTipo<'dona' | 'pastel' | 'barras'>
          etiqueta="Tipo de grafica"
          valor={tipo}
          alCambiar={setTipo}
          opciones={[
            { valor: 'dona', texto: 'Dona' },
            { valor: 'pastel', texto: 'Pastel' },
            { valor: 'barras', texto: 'Barras' },
          ]}
        />
      </Cabecera>
      <div className="grafica" role="img" aria-label="Distribucion de produccion por proyecto">
        <ResponsiveContainer width="100%" height="100%">
          {tipo === 'barras' ? (
            <BarChart data={datos} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={paleta.rejilla} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: paleta.texto }} tickFormatter={(v) => numero(v, 0)} />
              <YAxis type="category" dataKey="proyecto" tick={{ fontSize: 11, fill: paleta.texto }} width={150} />
              <Tooltip formatter={(valor: number) => `${numero(valor)} kWh`} />
              <Bar dataKey="kwh" name="Generacion (kWh)" radius={[0, 6, 6, 0]} isAnimationActive={animar} animationDuration={DURACION}>
                {datos.map((_, i) => (
                  <Cell key={i} fill={paleta.serie[i % paleta.serie.length]} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <PieChart>
              <Pie
                data={datos}
                dataKey="kwh"
                nameKey="proyecto"
                cx="50%"
                cy="50%"
                innerRadius={tipo === 'dona' ? '55%' : 0}
                outerRadius="82%"
                paddingAngle={tipo === 'dona' ? 3 : 0}
                cornerRadius={tipo === 'dona' ? 6 : 0}
                stroke={paleta.fondo}
                isAnimationActive={animar}
                animationDuration={DURACION}
                label={
                  tipo === 'pastel'
                    ? (entrada: { percent?: number }) => `${numero((entrada.percent ?? 0) * 100, 1)}%`
                    : false
                }
                labelLine={false}
              >
                {datos.map((_, indice) => (
                  <Cell key={indice} fill={paleta.serie[indice % paleta.serie.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(valor: number) => `${numero(valor)} kWh`} />
              <Legend />
            </PieChart>
          )}
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

// ---------------------------------------------------------------------------
// Ranking horizontal
// ---------------------------------------------------------------------------

export function GraficaBarrasComparacion({
  datos,
  etiquetaValor = 'kWh',
}: {
  datos: Array<{ nombre: string; valor: number }>;
  etiquetaValor?: string;
}) {
  const paleta = usePaleta();
  const animar = useAnimar();
  const idDegradado = useId().replace(/:/g, '');

  if (datos.length === 0) {
    return <p className="estado">No hay elementos comparables en el periodo seleccionado.</p>;
  }

  return (
    <figure style={{ margin: 0 }}>
      <div className="grafica" role="img" aria-label={`Comparacion por ${etiquetaValor}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={datos} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
            <defs>
              <linearGradient id={idDegradado} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={paleta.serie[0]} stopOpacity={0.55} />
                <stop offset="100%" stopColor={paleta.serie[0]} stopOpacity={1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={paleta.rejilla} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11, fill: paleta.texto }} tickFormatter={(v) => numero(v, 0)} />
            <YAxis type="category" dataKey="nombre" tick={{ fontSize: 11, fill: paleta.texto }} width={185} />
            <Tooltip formatter={(valor: number) => `${numero(valor)} ${etiquetaValor}`} />
            <Bar
              dataKey="valor"
              name={etiquetaValor}
              fill={`url(#${idDegradado})`}
              radius={[0, 8, 8, 0]}
              isAnimationActive={animar}
              animationDuration={DURACION}
            />
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

// ---------------------------------------------------------------------------
// Medidor (velocimetro) de cumplimiento
// ---------------------------------------------------------------------------

export function GraficaMedidor({
  valor,
  etiqueta,
  detalle,
  maximo = 120,
}: {
  /** Porcentaje (puede superar 100). `null` = sin base de comparacion. */
  valor: number | null;
  etiqueta: string;
  detalle?: string;
  maximo?: number;
}) {
  const paleta = usePaleta();
  const animar = useAnimar();

  if (valor === null) {
    return <p className="estado">Sin proyeccion aprobada para calcular el cumplimiento.</p>;
  }

  const acotado = Math.max(0, Math.min(valor, maximo));
  const color = valor >= 100 ? paleta.serie[1] : valor >= 80 ? paleta.serie[2] : paleta.serie[4];
  const datos = [{ nombre: etiqueta, valor: acotado, fill: color }];

  return (
    <figure style={{ margin: 0 }}>
      <div
        className="grafica grafica--medidor"
        role="img"
        aria-label={`${etiqueta}: ${numero(valor, 1)} por ciento`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            data={datos}
            startAngle={200}
            endAngle={-20}
            innerRadius="72%"
            outerRadius="100%"
            barSize={22}
          >
            <PolarAngleAxis type="number" domain={[0, maximo]} tick={false} />
            <RadialBar
              dataKey="valor"
              background={{ fill: paleta.rejilla }}
              cornerRadius={14}
              isAnimationActive={animar}
              animationDuration={1200}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="medidor__centro">
          <span className="medidor__valor" style={{ color }}>
            {numero(valor, 1)}%
          </span>
          <span className="medidor__etiqueta">{etiqueta}</span>
        </div>
      </div>
      {detalle ? (
        <p style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--texto-suave)' }}>{detalle}</p>
      ) : null}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Mapa de arbol (peso relativo de cada grupo / proyecto)
// ---------------------------------------------------------------------------

interface NodoArbol {
  name: string;
  size: number;
  [clave: string]: unknown;
}

function CeldaArbol(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  name?: string;
  colores: string[];
}) {
  const { x = 0, y = 0, width = 0, height = 0, index = 0, name = '', colores } = props;
  if (width < 4 || height < 4) return null;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={8}
        fill={colores[index % colores.length]}
        fillOpacity={0.88}
        stroke="var(--superficie)"
        strokeWidth={3}
      />
      {width > 70 && height > 28 ? (
        <text x={x + 10} y={y + 20} fill="#fff" fontSize={12} fontWeight={600}>
          {name.length > Math.floor(width / 7) ? `${name.slice(0, Math.floor(width / 7) - 1)}…` : name}
        </text>
      ) : null}
    </g>
  );
}

export function GraficaMapaArbol({
  datos,
  etiquetaValor = 'kWh',
}: {
  datos: Array<{ nombre: string; valor: number }>;
  etiquetaValor?: string;
}) {
  const paleta = usePaleta();
  const animar = useAnimar();
  const nodos: NodoArbol[] = datos.filter((d) => d.valor > 0).map((d) => ({ name: d.nombre, size: d.valor }));

  if (nodos.length === 0) {
    return <p className="estado">No hay produccion por grupo en el periodo.</p>;
  }

  return (
    <figure style={{ margin: 0 }}>
      <div className="grafica grafica--media" role="img" aria-label={`Peso relativo por ${etiquetaValor}`}>
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={nodos}
            dataKey="size"
            nameKey="name"
            isAnimationActive={animar}
            animationDuration={DURACION}
            content={<CeldaArbol colores={paleta.serie} />}
          >
            <Tooltip formatter={(valor: number) => `${numero(valor)} ${etiquetaValor}`} />
          </Treemap>
        </ResponsiveContainer>
      </div>
      <AlternativaTextual
        resumen={`Peso relativo de ${nodos.length} elemento(s) por ${etiquetaValor}.`}
        cabeceras={['Elemento', etiquetaValor]}
        filas={nodos.map((n) => [n.name, numero(n.size)])}
      />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Mini grafica de tendencia para las tarjetas de indicadores
// ---------------------------------------------------------------------------

export function Sparkline({ valores, etiqueta }: { valores: number[]; etiqueta: string }) {
  const paleta = usePaleta();
  const animar = useAnimar();
  const idDegradado = useId().replace(/:/g, '');
  if (valores.length < 2) return null;
  const datos = valores.map((v, i) => ({ i, v }));

  return (
    <div className="indicador__spark" role="img" aria-label={`Tendencia de ${etiqueta}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={datos} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={idDegradado} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={paleta.serie[0]} stopOpacity={0.45} />
              <stop offset="100%" stopColor={paleta.serie[0]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            dataKey="v"
            type="monotone"
            stroke={paleta.serie[0]}
            strokeWidth={2}
            fill={`url(#${idDegradado})`}
            isAnimationActive={animar}
            animationDuration={DURACION}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cumplimiento mensual contra la proyeccion (100 % = meta)
// ---------------------------------------------------------------------------

export function GraficaCumplimiento({
  filas,
}: {
  filas: Array<{ mes: string; cumplimiento: number | null; generacion_kwh: number; proyeccion_kwh: number | null }>;
}) {
  const [tipo, setTipo] = useState<'barras' | 'lineas'>('barras');
  const paleta = usePaleta();
  const animar = useAnimar();
  const datos = filas
    .filter((f) => f.cumplimiento !== null)
    .map((f) => ({ ...f, etiqueta: f.mes.split(' ')[0], cumplimiento: Number(f.cumplimiento) }));

  if (datos.length === 0) {
    return <p className="estado">No hay meses con proyeccion aprobada para medir el cumplimiento.</p>;
  }

  const ejes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={paleta.rejilla} vertical={false} />
      <XAxis dataKey="etiqueta" tick={{ fontSize: 11, fill: paleta.texto }} tickLine={false} />
      <YAxis
        tick={{ fontSize: 11, fill: paleta.texto }}
        tickFormatter={(v) => `${numero(v, 0)}%`}
        width={56}
        tickLine={false}
        axisLine={false}
      />
      <Tooltip formatter={(valor: number) => `${numero(valor, 1)} %`} />
      <ReferenceLine y={100} stroke={paleta.serie[2]} strokeDasharray="6 4" label={{ value: 'Meta 100 %', fill: paleta.texto, fontSize: 11, position: 'insideTopRight' }} />
    </>
  );

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="solo-lectores">
        Cumplimiento mensual: generacion real entre proyeccion, en porcentaje.
      </figcaption>
      <Cabecera>
        <SelectorTipo<'barras' | 'lineas'>
          etiqueta="Tipo de grafica"
          valor={tipo}
          alCambiar={setTipo}
          opciones={[
            { valor: 'barras', texto: 'Barras' },
            { valor: 'lineas', texto: 'Lineas' },
          ]}
        />
      </Cabecera>
      <div className="grafica grafica--media" role="img" aria-label="Cumplimiento mensual de la proyeccion">
        <ResponsiveContainer width="100%" height="100%">
          {tipo === 'barras' ? (
            <BarChart data={datos} margin={{ top: 14, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Bar dataKey="cumplimiento" name="Cumplimiento" radius={[6, 6, 0, 0]} isAnimationActive={animar} animationDuration={DURACION}>
                {datos.map((d, i) => (
                  <Cell key={i} fill={d.cumplimiento >= 100 ? paleta.serie[1] : d.cumplimiento >= 80 ? paleta.serie[2] : paleta.serie[4]} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <LineChart data={datos} margin={{ top: 14, right: 18, left: 6, bottom: 6 }}>
              {ejes}
              <Line dataKey="cumplimiento" name="Cumplimiento" stroke={paleta.serie[0]} strokeWidth={3} type="monotone" dot={{ r: 4 }} isAnimationActive={animar} animationDuration={DURACION} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <AlternativaTextual
        resumen="Cumplimiento mensual de la proyeccion en porcentaje."
        cabeceras={['Mes', 'Proyeccion (kWh)', 'Generacion (kWh)', 'Cumplimiento']}
        filas={datos.map((d) => [
          d.mes,
          d.proyeccion_kwh === null ? 'Sin proyeccion' : numero(d.proyeccion_kwh),
          numero(d.generacion_kwh),
          `${numero(d.cumplimiento, 1)} %`,
        ])}
      />
    </figure>
  );
}
