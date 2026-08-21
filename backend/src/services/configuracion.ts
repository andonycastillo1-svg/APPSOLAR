import { query, execute } from '../db/pool';

export interface ParametroConfiguracion {
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

let cache: Map<string, ParametroConfiguracion> | null = null;
let cacheVence = 0;
const TTL_MS = 30_000;

async function cargar(): Promise<Map<string, ParametroConfiguracion>> {
  if (cache && Date.now() < cacheVence) return cache;
  const filas = await query<ParametroConfiguracion>('SELECT * FROM configuracion');
  cache = new Map(filas.map((f) => [f.clave, f]));
  cacheVence = Date.now() + TTL_MS;
  return cache;
}

export function invalidarCache(): void {
  cache = null;
  cacheVence = 0;
}

export async function listarConfiguracion(): Promise<ParametroConfiguracion[]> {
  const mapa = await cargar();
  return [...mapa.values()].sort(
    (a, b) => a.categoria.localeCompare(b.categoria) || a.clave.localeCompare(b.clave),
  );
}

export async function obtenerTexto(clave: string, porDefecto: string): Promise<string> {
  const mapa = await cargar();
  return mapa.get(clave)?.valor ?? porDefecto;
}

export async function obtenerNumero(clave: string, porDefecto: number): Promise<number> {
  const valor = await obtenerTexto(clave, String(porDefecto));
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : porDefecto;
}

export async function obtenerBooleano(clave: string, porDefecto: boolean): Promise<boolean> {
  const valor = await obtenerTexto(clave, String(porDefecto));
  return ['1', 'true', 'si'].includes(valor.toLowerCase());
}

export async function actualizarParametro(
  clave: string,
  valor: string,
  idUsuario: number,
): Promise<void> {
  await execute(
    'UPDATE configuracion SET valor = ?, updated_by = ? WHERE clave = ? AND editable = 1',
    [valor, idUsuario, clave],
  );
  invalidarCache();
}

/** Factores ambientales configurables, con su unidad y fuente declaradas. */
export async function factoresAmbientales() {
  const mapa = await cargar();
  const co2 = mapa.get('ambiental.factor_co2');
  const arbol = mapa.get('ambiental.co2_por_arbol');
  return {
    factorCo2: Number(co2?.valor ?? 0.4523),
    factorCo2Unidad: co2?.unidad ?? 'tCO2e/MWh',
    factorCo2Fuente: co2?.fuente ?? 'No configurada',
    co2PorArbol: Number(arbol?.valor ?? 0.0217),
    co2PorArbolUnidad: arbol?.unidad ?? 'tCO2e/arbol/anio',
    co2PorArbolFuente: arbol?.fuente ?? 'No configurada',
  };
}
