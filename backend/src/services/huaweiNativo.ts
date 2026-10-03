import { env } from '../config/env';
import { AppError } from '../utils/errors';
import type {
  ConfiguracionAdaptador,
  RegistroCanonico,
  RespuestaPrueba,
  RespuestaSincronizacion,
} from './huaweiCliente';

/**
 * Adaptador Huawei SmartPVMS (FusionSolar Northbound) implementado en Node.js.
 *
 * Equivale al adaptador del servicio Python en modo REAL y permite desplegar
 * el sistema sin ese servicio (por ejemplo en un hosting que solo ejecuta
 * Node.js). Se activa con HUAWEI_ADAPTER=node. Las credenciales provienen
 * unicamente del entorno (HUAWEI_USERNAME / HUAWEI_SYSTEM_CODE).
 */

export class ErrorAdaptador extends Error {
  constructor(
    public codigo: string,
    mensaje: string,
    public detalle: Record<string, unknown> = {},
  ) {
    super(mensaje);
  }
}

const CODIGOS_HUAWEI: Record<number, [string, string]> = {
  20001: ['CREDENCIALES_INVALIDAS', 'Usuario o systemCode invalidos.'],
  20002: ['CREDENCIALES_INVALIDAS', 'La cuenta no tiene permisos northbound.'],
  20005: ['LIMITE_API', 'Se alcanzo el limite de peticiones por intervalo.'],
  20006: ['LIMITE_API', 'Se alcanzo el limite de peticiones por intervalo.'],
  20007: ['CREDENCIALES_INVALIDAS', 'La sesion expiro; vuelva a autenticar.'],
  20008: ['IP_NO_AUTORIZADA', 'La IP de origen no esta autorizada.'],
  305: ['CREDENCIALES_INVALIDAS', 'No autenticado ante SmartPVMS.'],
  401: ['CREDENCIALES_INVALIDAS', 'Credenciales rechazadas por SmartPVMS.'],
  407: ['LIMITE_API', 'Frecuencia de consulta excedida.'],
  20618: ['LIMITE_API', 'Se alcanzo el limite diario de llamadas permitidas por usuario.'],
};

function traducirFallo(codigo: unknown, mensaje: unknown): ErrorAdaptador {
  const numerico = Number(codigo);
  const conocido = Number.isFinite(numerico) ? CODIGOS_HUAWEI[numerico] : undefined;
  if (conocido) return new ErrorAdaptador(conocido[0], conocido[1], { codigoFabricante: codigo });
  return new ErrorAdaptador(
    'FORMATO_INESPERADO',
    typeof mensaje === 'string' && mensaje ? mensaje : 'SmartPVMS devolvio un codigo de fallo no documentado.',
    { codigoFabricante: codigo },
  );
}

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

interface Sesion {
  token: string | null;
}

interface Respuesta {
  status: number;
  json: Record<string, any> | null;
  token: string | null;
}

async function post(
  cfg: ConfiguracionAdaptador,
  ruta: string,
  cuerpo: unknown,
  token?: string | null,
): Promise<Respuesta> {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), cfg.timeout_s * 1000);
  try {
    const respuesta = await fetch(`${cfg.endpoint.replace(/\/+$/, '')}${ruta}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'XSRF-TOKEN': token } : {}),
      },
      body: JSON.stringify(cuerpo),
      signal: control.signal,
    });
    const texto = await respuesta.text();
    let json: Record<string, any> | null = null;
    try {
      json = texto ? (JSON.parse(texto) as Record<string, any>) : null;
    } catch {
      json = null;
    }
    return { status: respuesta.status, json, token: respuesta.headers.get('xsrf-token') };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new ErrorAdaptador('TIEMPO_AGOTADO', `Tiempo de espera agotado consultando ${ruta}.`);
    }
    const causa = (error as { cause?: { code?: string; message?: string } }).cause;
    const motivo = [causa?.code, causa?.message ?? (error as Error).message].filter(Boolean).join(' - ');
    throw new ErrorAdaptador('SERVICIO_NO_DISPONIBLE', `No fue posible alcanzar SmartPVMS (${ruta}): ${motivo}`, {
      motivo,
      ruta,
    });
  } finally {
    clearTimeout(temporizador);
  }
}

function exigirCredenciales(): { usuario: string; systemCode: string } {
  const { username, systemCode } = env.huawei;
  if (!username || !systemCode) {
    throw new ErrorAdaptador(
      'CONFIGURACION_INCOMPLETA',
      'Faltan HUAWEI_USERNAME o HUAWEI_SYSTEM_CODE en el entorno del servidor.',
    );
  }
  return { usuario: username, systemCode };
}

async function autenticar(cfg: ConfiguracionAdaptador, sesion: Sesion): Promise<void> {
  const { usuario, systemCode } = exigirCredenciales();
  const r = await post(cfg, '/login', { userName: usuario, systemCode });

  if (r.status === 403) {
    throw new ErrorAdaptador(
      'IP_NO_AUTORIZADA',
      'SmartPVMS rechazo la conexion: la IP de origen no esta autorizada.',
    );
  }
  if (!r.json) throw new ErrorAdaptador('FORMATO_INESPERADO', 'La respuesta de login no es JSON.');
  if (!r.json.success) throw traducirFallo(r.json.failCode, r.json.message);
  if (!r.token) {
    throw new ErrorAdaptador(
      'FORMATO_INESPERADO',
      'SmartPVMS no devolvio el token de sesion (XSRF-TOKEN).',
    );
  }
  sesion.token = r.token;
}

async function peticion(
  cfg: ConfiguracionAdaptador,
  sesion: Sesion,
  ruta: string,
  carga: unknown,
): Promise<Record<string, any>> {
  if (!sesion.token) await autenticar(cfg, sesion);

  let ultimo: ErrorAdaptador | null = null;
  for (let intento = 0; intento <= cfg.max_reintentos; intento++) {
    let r: Respuesta;
    try {
      r = await post(cfg, ruta, carga, sesion.token);
    } catch (error) {
      if (error instanceof ErrorAdaptador) {
        ultimo = error;
        await dormir(Math.min(2 ** intento, 8) * 1000);
        continue;
      }
      throw error;
    }

    if (r.status === 403) {
      throw new ErrorAdaptador('IP_NO_AUTORIZADA', 'SmartPVMS rechazo la peticion: IP de origen no autorizada.');
    }
    if (!r.json) {
      throw new ErrorAdaptador('FORMATO_INESPERADO', `La respuesta de ${ruta} no es JSON valido.`);
    }
    if (r.json.success) return r.json;

    const fallo = traducirFallo(r.json.failCode, r.json.message);

    if (fallo.codigo === 'CREDENCIALES_INVALIDAS' && intento === 0) {
      sesion.token = null;
      await autenticar(cfg, sesion);
      continue;
    }
    if (fallo.codigo === 'LIMITE_API' && intento < cfg.max_reintentos) {
      ultimo = fallo;
      await dormir((Math.min(2 ** intento, 8) + 1) * 1000);
      continue;
    }
    throw fallo;
  }
  throw ultimo ?? new ErrorAdaptador('SERVICIO_NO_DISPONIBLE', 'Sin respuesta de SmartPVMS.');
}

// ---------------------------------------------------------------------------
// Prueba de conexion
// ---------------------------------------------------------------------------

export async function probarConexionNativo(cfg: ConfiguracionAdaptador): Promise<RespuestaPrueba> {
  if (cfg.modo === 'MOCK') {
    return {
      ok: true,
      modo: 'MOCK',
      mensaje:
        'Conexion simulada correcta. El adaptador esta en modo sandbox: no se contacto la plataforma real del fabricante.',
      ip_saliente: null,
      detalle: {
        endpoint: cfg.endpoint,
        credencialesConfiguradas: Boolean(env.huawei.username && env.huawei.systemCode),
      },
    };
  }

  exigirCredenciales();

  let ipSaliente: string | null = null;
  try {
    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), 6000);
    const r = await fetch('https://api.ipify.org?format=json', { signal: control.signal });
    clearTimeout(temporizador);
    if (r.ok) ipSaliente = ((await r.json()) as { ip?: string }).ip ?? null;
  } catch {
    ipSaliente = null;
  }

  const esperada = cfg.ip_autorizada || env.huawei.authorizedIp;
  if (esperada && ipSaliente && esperada !== ipSaliente) {
    throw new ErrorAdaptador(
      'IP_NO_AUTORIZADA',
      `La IP publica de salida (${ipSaliente}) no coincide con la autorizada (${esperada}). ` +
        'Actualice el registro ante Huawei antes de sincronizar.',
      { ipSaliente, ipAutorizada: esperada },
    );
  }

  const sesion: Sesion = { token: null };
  await autenticar(cfg, sesion);
  const cuerpo = await peticion(cfg, sesion, '/getStationList', {});
  const estaciones = (cuerpo.data as Array<Record<string, any>> | undefined) ?? [];

  return {
    ok: true,
    modo: 'REAL',
    mensaje: `Conexion establecida con SmartPVMS. Estaciones accesibles: ${estaciones.length}.`,
    ip_saliente: ipSaliente,
    detalle: {
      estaciones: estaciones.slice(0, 20).map((e) => ({ codigo: e.stationCode, nombre: e.stationName })),
    },
  };
}

// ---------------------------------------------------------------------------
// Produccion
// ---------------------------------------------------------------------------

const aFecha = (iso: string) => {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d));
};
const aISO = (f: Date) => f.toISOString().slice(0, 10);

export async function obtenerProduccionNativo(
  cfg: ConfiguracionAdaptador,
  p: {
    seriales: string[];
    estaciones?: string[];
    desde: string;
    hasta: string;
    granularidad: 'DIARIA' | 'MENSUAL';
  },
): Promise<RespuestaSincronizacion> {
  const inicio = Date.now();
  const desde = aFecha(p.desde);
  const hasta = aFecha(p.hasta);

  if (desde > hasta) {
    throw new ErrorAdaptador('FORMATO_INESPERADO', 'La fecha inicial no puede ser posterior a la final.');
  }
  const dias = Math.round((hasta.getTime() - desde.getTime()) / 86_400_000);
  const maximo = p.granularidad === 'DIARIA' ? 800 : 3700;
  if (dias > maximo) {
    throw new ErrorAdaptador(
      'LIMITE_API',
      `El rango solicitado supera los ${maximo} dias para esta granularidad. Divida la consulta en periodos menores.`,
    );
  }
  if (cfg.modo === 'MOCK') {
    throw new AppError(
      422,
      'MODO_SIMULADO_NO_DISPONIBLE',
      'El adaptador nativo solo opera con la plataforma real (modo REAL). Cambie la integracion a REAL.',
    );
  }

  const registros: RegistroCanonico[] = [];
  const advertencias: string[] = [];
  const estacionesResueltas: Record<string, string> = {};
  const sesion: Sesion = { token: null };
  await autenticar(cfg, sesion);

  // serial (minusculas) -> id de dispositivo; devTypeId: 1 string, 38 residencial.
  const idPorSerial = new Map<string, string>();
  const tipoPorId = new Map<string, number>();

  const cargarDispositivos = async (codigos: string[]) => {
    for (let i = 0; i < codigos.length; i += 100) {
      const lote = codigos.slice(i, i + 100);
      const cuerpo = await peticion(cfg, sesion, '/getDevList', { stationCodes: lote.join(',') });
      for (const d of (cuerpo.data as Array<Record<string, any>> | undefined) ?? []) {
        const sn = String(d.esnCode || d.devDn || '');
        if (!sn) continue;
        const id = String(d.id);
        idPorSerial.set(sn.toLowerCase(), id);
        tipoPorId.set(id, Number(d.devTypeId) || 1);
        if (d.stationCode) estacionesResueltas[sn.toLowerCase()] = String(d.stationCode);
      }
    }
  };

  const declaradas = p.estaciones ?? [];
  if (declaradas.length > 0) await cargarDispositivos(declaradas);

  if (p.seriales.some((s) => !idPorSerial.has(s.toLowerCase()))) {
    const lista = await peticion(cfg, sesion, '/getStationList', {});
    const yaConsultadas = new Set(declaradas);
    const codigos = ((lista.data as Array<Record<string, any>> | undefined) ?? [])
      .map((e) => (e.stationCode ? String(e.stationCode) : ''))
      .filter((c) => c && !yaConsultadas.has(c));
    await cargarDispositivos(codigos);
  }

  const pedidos = new Set(p.seriales.map((s) => s.toLowerCase()));
  for (const clave of Object.keys(estacionesResueltas)) {
    if (!pedidos.has(clave)) delete estacionesResueltas[clave];
  }

  const faltantes = p.seriales.filter((s) => !idPorSerial.has(s.toLowerCase()));
  if (faltantes.length > 0) {
    advertencias.push(`SmartPVMS no reporto estos dispositivos: ${faltantes.join(', ')}`);
  }

  const ids = p.seriales.map((s) => idPorSerial.get(s.toLowerCase())).filter(Boolean) as string[];
  if (ids.length > 0) {
    const serialDeId = new Map([...idPorSerial].map(([sn, id]) => [id, sn]));
    const serialOriginal = new Map(p.seriales.map((s) => [s.toLowerCase(), s]));
    const inicioRango = p.granularidad === 'DIARIA' ? p.desde : `${p.desde.slice(0, 8)}01`;
    const vistos = new Set<string>();
    const ruta = p.granularidad === 'DIARIA' ? '/getDevKpiDay' : '/getDevKpiMonth';

    // Huawei devuelve el mes completo (diario) o el año completo (mensual).
    let actual =
      p.granularidad === 'DIARIA'
        ? new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth(), 1))
        : new Date(Date.UTC(desde.getUTCFullYear(), 0, 1));

    while (actual <= hasta) {
      // A mitad de periodo: la hora se interpreta en la zona de la planta.
      const referencia =
        p.granularidad === 'DIARIA'
          ? Date.UTC(actual.getUTCFullYear(), actual.getUTCMonth(), 15, 12)
          : Date.UTC(actual.getUTCFullYear(), 6, 1, 12);

      const filas: Array<Record<string, any>> = [];
      for (const tipo of [...new Set(ids.map((i) => tipoPorId.get(i) ?? 1))].sort((a, b) => a - b)) {
        const idsTipo = ids.filter((i) => (tipoPorId.get(i) ?? 1) === tipo);
        const cuerpo = await peticion(cfg, sesion, ruta, {
          devIds: idsTipo.join(','),
          devTypeId: tipo,
          collectTime: referencia,
        });
        filas.push(...((cuerpo.data as Array<Record<string, any>> | undefined) ?? []));
      }

      for (const fila of filas) {
        const energia = fila.dataItemMap?.product_power;
        if (energia === null || energia === undefined) continue;
        const devId = String(fila.devId);
        const sn = serialDeId.get(devId) ?? devId;
        const fecha = aISO(new Date(Number(fila.collectTime ?? referencia)));
        if (fecha < inicioRango || fecha > p.hasta) continue;
        const clave = `${sn}|${fecha}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        registros.push({
          serial: serialOriginal.get(sn) ?? sn,
          fecha,
          kwh: Math.round(Number(energia) * 10000) / 10000,
          granularidad: p.granularidad,
          estacion: estacionesResueltas[sn] ?? null,
        });
      }

      actual =
        p.granularidad === 'DIARIA'
          ? new Date(Date.UTC(actual.getUTCFullYear(), actual.getUTCMonth() + 1, 1))
          : new Date(Date.UTC(actual.getUTCFullYear() + 1, 0, 1));
    }
  }

  return {
    ok: true,
    modo: 'REAL',
    registros,
    advertencias,
    estaciones_resueltas: estacionesResueltas,
    duracion_ms: Date.now() - inicio,
    rango: { desde: p.desde, hasta: p.hasta },
  };
}
