import { execute, query, queryOne, withTransaction } from '../db/pool';
import { AppError, errores } from '../utils/errors';
import { logger } from '../config/logger';
import { conBloqueo } from './bloqueos';
import { obtenerProduccion, type ConfiguracionAdaptador } from './huaweiCliente';
import { CacheTarifas, calcularValorizacion, mesEstaCerrado } from './valorizacion';
import { registrarAuditoria } from './auditoria';
import { hoyISO, primerDiaMes, ultimoDiaMes } from '../utils/fechas';

export interface ParametrosSincronizacion {
  idApi: number;
  idProyecto?: number | null;
  idInversor?: number | null;
  /** Limita la sincronizacion a estos inversores (p. ej. los recien agregados). */
  idsInversores?: number[] | null;
  desde: string;
  hasta: string;
  granularidad: 'DIARIA' | 'MENSUAL';
  tipo: 'MANUAL' | 'PROGRAMADA' | 'PRUEBA';
  idUsuario: number | null;
  emailUsuario?: string | null;
}

export interface ResultadoSincronizacion {
  id_sync: number;
  estado: 'COMPLETADA' | 'COMPLETADA_CON_ERRORES' | 'FALLIDA';
  modo: 'MOCK' | 'REAL';
  filasRecibidas: number;
  insertadas: number;
  actualizadas: number;
  rechazadas: number;
  pendientesTarifa: number;
  duracionMs: number;
  advertencias: string[];
  mensaje: string;
}

interface InversorSincronizable {
  id_inversor: number;
  id_proyecto: number;
  id_grupo: number;
  serial_externo: string;
  estacion_externa: string | null;
}

/**
 * Flujo completo de sincronizacion Huawei (pasos 3 a 8 del alcance):
 * valida configuracion, bloquea concurrencia, pide los datos al servicio
 * Python, revalida en Node, inserta/actualiza de forma IDEMPOTENTE y registra
 * la ejecucion con sus metricas.
 */
export async function ejecutarSincronizacion(
  parametros: ParametrosSincronizacion,
): Promise<ResultadoSincronizacion> {
  const inicio = Date.now();

  const api = await queryOne<{
    id_api: number;
    marca: string;
    endpoint: string;
    ip_autorizada: string | null;
    usuario_api: string | null;
    modo: 'MOCK' | 'REAL';
    estado: string;
    timeout_s: number;
    max_reintentos: number;
  }>('SELECT * FROM apis_fabricante WHERE id_api = ?', [parametros.idApi]);

  if (!api) throw errores.noEncontrado('la configuracion de integracion indicada');
  if (api.estado !== 'ACTIVA') {
    throw errores.reglaNegocio(
      `La integracion "${api.marca}" no esta activa (estado actual: ${api.estado}). ` +
        'Actívela desde Configuracion de integracion antes de sincronizar.',
    );
  }
  if (parametros.desde > parametros.hasta) {
    throw errores.validacion('La fecha inicial no puede ser posterior a la fecha final.');
  }
  if (parametros.hasta > hoyISO()) {
    throw errores.validacion('No se puede sincronizar un rango con fechas futuras.');
  }

  // La consulta diaria siempre abarca MESES COMPLETOS (hasta hoy). Huawei entrega
  // el mes entero en una sola llamada, de modo que no cuesta mas, y asi el mes
  // nunca queda con solo unos dias sincronizados (lo que descuadraba el total
  // mensual frente a la cifra mensual del fabricante).
  let desde = parametros.desde;
  let hasta = parametros.hasta;
  if (parametros.granularidad === 'DIARIA') {
    desde = primerDiaMes(Number(desde.slice(0, 4)), Number(desde.slice(5, 7)));
    const finDeMes = ultimoDiaMes(Number(hasta.slice(0, 4)), Number(hasta.slice(5, 7)));
    hasta = finDeMes > hoyISO() ? hoyISO() : finDeMes;
  }

  // Inversores elegibles: solo los declarados como HUAWEI_API y con serial.
  const condiciones = [
    "i.tipo_conexion = 'HUAWEI_API'",
    'i.activo = 1',
    'i.serial_externo IS NOT NULL',
    'i.id_api = ?',
  ];
  const params: unknown[] = [parametros.idApi];
  if (parametros.idInversor) {
    condiciones.push('i.id_inversor = ?');
    params.push(parametros.idInversor);
  }
  if (parametros.idProyecto) {
    condiciones.push('i.id_proyecto = ?');
    params.push(parametros.idProyecto);
  }
  if (parametros.idsInversores && parametros.idsInversores.length > 0) {
    condiciones.push(`i.id_inversor IN (${parametros.idsInversores.map(() => '?').join(',')})`);
    params.push(...parametros.idsInversores);
  }

  const inversores = await query<InversorSincronizable>(
    `SELECT i.id_inversor, i.id_proyecto, i.id_grupo, i.serial_externo, i.estacion_externa
       FROM inversores i WHERE ${condiciones.join(' AND ')}`,
    params,
  );

  if (inversores.length === 0) {
    throw errores.reglaNegocio(
      'No hay inversores con conexion HUAWEI_API asociados a esta integracion y a los filtros indicados.',
    );
  }

  const recurso =
    `sync:huawei:${parametros.idApi}:${parametros.idProyecto ?? 'all'}:${parametros.idInversor ?? 'all'}` +
    (parametros.idsInversores?.length ? `:n${parametros.idsInversores.length}-${parametros.idsInversores[0]}` : '');

  return conBloqueo(
    recurso,
    parametros.idUsuario,
    Math.max(60, api.timeout_s * 2),
    `Sincronizacion ${parametros.tipo} de ${inversores.length} inversor(es)`,
    async () => {
      const registroSync = await execute(
        `INSERT INTO sincronizaciones
           (id_api, id_proyecto, id_inversor, tipo, modo, estado, rango_desde, rango_hasta,
            granularidad, id_usuario)
         VALUES (?, ?, ?, ?, ?, 'EN_PROCESO', ?, ?, ?, ?)`,
        [
          parametros.idApi,
          parametros.idProyecto ?? null,
          parametros.idInversor ?? null,
          parametros.tipo,
          api.modo,
          desde,
          hasta,
          parametros.granularidad,
          parametros.idUsuario,
        ],
      );
      const idSync = registroSync.insertId;

      const configuracion: ConfiguracionAdaptador = {
        modo: api.modo,
        endpoint: api.endpoint,
        ip_autorizada: api.ip_autorizada,
        usuario_api: api.usuario_api,
        timeout_s: api.timeout_s,
        max_reintentos: api.max_reintentos,
      };

      try {
        const respuesta = await obtenerProduccion(configuracion, {
          seriales: inversores.map((i) => i.serial_externo),
          estaciones: [...new Set(inversores.map((i) => i.estacion_externa).filter(Boolean) as string[])],
          desde,
          hasta,
          granularidad: parametros.granularidad,
        });

        const porSerial = new Map(inversores.map((i) => [i.serial_externo.toLowerCase(), i]));

        // La estacion se descubre sola a partir del serial: se guarda para que
        // las siguientes sincronizaciones no tengan que volver a buscarla.
        for (const [serial, estacion] of Object.entries(respuesta.estaciones_resueltas ?? {})) {
          const inversor = porSerial.get(serial);
          if (inversor && !inversor.estacion_externa) {
            await execute('UPDATE inversores SET estacion_externa = ? WHERE id_inversor = ?', [
              estacion.slice(0, 80),
              inversor.id_inversor,
            ]);
          }
        }
        let insertadas = 0;
        let actualizadas = 0;
        let rechazadas = 0;
        let pendientesTarifa = 0;
        const advertencias = [...respuesta.advertencias];
        const inversoresTocados = new Set<number>();

        await withTransaction(async (conn) => {
          const cache = new CacheTarifas(conn);

          for (const registro of respuesta.registros) {
            const inversor = porSerial.get(String(registro.serial).toLowerCase());
            if (!inversor) {
              rechazadas += 1;
              advertencias.push(`Se recibio produccion del serial "${registro.serial}", que no esta registrado.`);
              continue;
            }

            // Revalidacion en Node: el adaptador nunca es la unica barrera.
            if (!/^\d{4}-\d{2}-\d{2}$/.test(registro.fecha) || registro.fecha > hoyISO()) {
              rechazadas += 1;
              advertencias.push(`Fecha invalida o futura recibida para ${registro.serial}: ${registro.fecha}.`);
              continue;
            }
            if (!Number.isFinite(registro.kwh) || registro.kwh < 0) {
              rechazadas += 1;
              advertencias.push(`Valor de energia invalido para ${registro.serial} el ${registro.fecha}.`);
              continue;
            }

            const anio = Number(registro.fecha.slice(0, 4));
            const mes = Number(registro.fecha.slice(5, 7));

            if (await mesEstaCerrado(inversor.id_proyecto, anio, mes, conn)) {
              rechazadas += 1;
              advertencias.push(
                `El periodo ${String(mes).padStart(2, '0')}/${anio} esta cerrado; se omitieron los datos de ${registro.serial}.`,
              );
              continue;
            }

            const fecha =
              registro.granularidad === 'MENSUAL' ? `${registro.fecha.slice(0, 7)}-01` : registro.fecha;

            const valorizacion = await calcularValorizacion(
              inversor.id_proyecto,
              anio,
              mes,
              registro.kwh,
              cache,
              conn,
            );
            if (valorizacion.estado_valorizacion === 'PENDIENTE_DE_TARIFA') pendientesTarifa += 1;

            // Idempotencia: la clave unica evita duplicar en re-sincronizaciones.
            const existente = await queryOne<{ id_produccion: number; kwh: number }>(
              `SELECT id_produccion, kwh FROM produccion
                WHERE id_proyecto = ? AND COALESCE(id_inversor, 0) = ? AND fecha = ?
                  AND granularidad = ? AND origen = 'HUAWEI_API' AND secuencia = 0`,
              [inversor.id_proyecto, inversor.id_inversor, fecha, registro.granularidad],
              conn,
            );

            if (existente) {
              await execute(
                `UPDATE produccion
                    SET kwh = ?, id_tarifa = ?, costo_kwh_aplicado = ?, valor_q = ?,
                        estado_valorizacion = ?, id_sync = ?
                  WHERE id_produccion = ?`,
                [
                  registro.kwh,
                  valorizacion.id_tarifa,
                  valorizacion.costo_kwh_aplicado,
                  valorizacion.valor_q,
                  valorizacion.estado_valorizacion,
                  idSync,
                  existente.id_produccion,
                ],
                conn,
              );
              actualizadas += 1;
            } else {
              await execute(
                `INSERT INTO produccion
                   (id_proyecto, id_inversor, id_grupo, nivel_detalle, fecha, anio, mes,
                    granularidad, kwh, origen, secuencia, id_sync, id_tarifa,
                    costo_kwh_aplicado, valor_q, estado_valorizacion)
                 VALUES (?, ?, ?, 'POR_INVERSOR', ?, ?, ?, ?, ?, 'HUAWEI_API', 0, ?, ?, ?, ?, ?)`,
                [
                  inversor.id_proyecto,
                  inversor.id_inversor,
                  inversor.id_grupo,
                  fecha,
                  anio,
                  mes,
                  registro.granularidad,
                  registro.kwh,
                  idSync,
                  valorizacion.id_tarifa,
                  valorizacion.costo_kwh_aplicado,
                  valorizacion.valor_q,
                  valorizacion.estado_valorizacion,
                ],
                conn,
              );
              insertadas += 1;
            }

            inversoresTocados.add(inversor.id_inversor);
          }

          for (const idInversor of inversoresTocados) {
            await execute(
              `UPDATE inversores i
                  SET i.ultima_actualizacion = (
                        SELECT MAX(p.fecha) FROM produccion p
                         WHERE p.id_inversor = i.id_inversor AND p.activo = 1)
                WHERE i.id_inversor = ?`,
              [idInversor],
              conn,
            );
          }
        });

        const duracionMs = Date.now() - inicio;
        const estado = rechazadas > 0 ? 'COMPLETADA_CON_ERRORES' : 'COMPLETADA';
        const mensaje =
          `Sincronizacion ${api.modo === 'MOCK' ? 'simulada ' : ''}finalizada: ` +
          `${insertadas} insertada(s), ${actualizadas} actualizada(s), ${rechazadas} rechazada(s).` +
          (pendientesTarifa > 0
            ? ` ${pendientesTarifa} registro(s) quedaron pendientes de tarifa.`
            : '');

        await execute(
          `UPDATE sincronizaciones
              SET estado = ?, filas_recibidas = ?, insertadas = ?, actualizadas = ?,
                  rechazadas = ?, duracion_ms = ?, mensaje = ?, detalle = ?, finalizada_en = NOW()
            WHERE id_sync = ?`,
          [
            estado,
            respuesta.registros.length,
            insertadas,
            actualizadas,
            rechazadas,
            duracionMs,
            mensaje.slice(0, 500),
            JSON.stringify({
              advertencias: advertencias.slice(0, 50),
              pendientesTarifa,
              // Distingue una pasada de TODOS los inversores de una acotada.
              ambito: parametros.idsInversores?.length
                ? 'SUBCONJUNTO'
                : parametros.idProyecto || parametros.idInversor
                  ? 'PARCIAL'
                  : 'TODOS',
            }),
            idSync,
          ],
        );

        await execute(
          'UPDATE apis_fabricante SET ultima_sincronizacion = NOW() WHERE id_api = ?',
          [parametros.idApi],
        );

        await registrarAuditoria({
          idUsuario: parametros.idUsuario,
          usuarioEmail: parametros.emailUsuario ?? null,
          accion: 'SINCRONIZACION_EJECUTADA',
          entidad: 'sincronizaciones',
          idEntidad: idSync,
          despues: { estado, insertadas, actualizadas, rechazadas, modo: api.modo },
        });

        return {
          id_sync: idSync,
          estado,
          modo: api.modo,
          filasRecibidas: respuesta.registros.length,
          insertadas,
          actualizadas,
          rechazadas,
          pendientesTarifa,
          duracionMs,
          advertencias: advertencias.slice(0, 50),
          mensaje,
        };
      } catch (error) {
        const duracionMs = Date.now() - inicio;
        const codigo = error instanceof AppError ? error.codigo : 'ERROR_INTERNO';
        const mensaje = error instanceof Error ? error.message : 'Error desconocido';

        await execute(
          `UPDATE sincronizaciones
              SET estado = 'FALLIDA', duracion_ms = ?, codigo_error = ?, mensaje = ?, finalizada_en = NOW()
            WHERE id_sync = ?`,
          [duracionMs, codigo.slice(0, 60), mensaje.slice(0, 500), idSync],
        );

        await registrarAuditoria({
          idUsuario: parametros.idUsuario,
          usuarioEmail: parametros.emailUsuario ?? null,
          accion: 'SINCRONIZACION_FALLIDA',
          entidad: 'sincronizaciones',
          idEntidad: idSync,
          resultado: 'FALLO',
          motivo: `${codigo}: ${mensaje}`.slice(0, 400),
        });

        logger.error({ err: error, idSync }, 'Sincronizacion Huawei fallida');
        throw error;
      }
    },
  );
}

export interface ResultadoSincronizacionAhora {
  id_sync: number;
  estado: 'COMPLETADA' | 'COMPLETADA_CON_ERRORES';
  modo: 'MOCK' | 'REAL';
  filasRecibidas: number;
  insertadas: number;
  actualizadas: number;
  rechazadas: number;
  pendientesTarifa: number;
  duracionMs: number;
  advertencias: string[];
  mensaje: string;
  desde: string;
  hasta: string;
  /** Proyectos con inversores recien agregados (sin datos de Huawei) que se validaron y cargaron completos. */
  proyectosNuevos: string[];
  /** Inversores Huawei que siguen sin ningun dato tras sincronizar. */
  inversoresSinDatos: string[];
  /** Huawei corto la sincronizacion por su limite de consultas; lo ya cargado se conservo. */
  limiteAlcanzado: boolean;
  /** Que se consulto realmente (para entender el gasto del cupo). */
  consultado: string[];
}

/** Indica si ya hay una sincronizacion MENSUAL completa de todos los inversores que cubra el anio. */
async function anioMensualVerificado(anio: number, anioActual: number): Promise<boolean> {
  const hoy = hoyISO();
  const hace7 = new Date(`${hoy}T00:00:00Z`);
  hace7.setUTCDate(hace7.getUTCDate() - 7);
  // Un anio ya terminado se verifica una sola vez (despues de terminar); el
  // anio en curso se vuelve a verificar cada 7 dias.
  const desdeEjecucion = anio < anioActual ? `${anio + 1}-01-01` : hace7.toISOString().slice(0, 10);
  const fila = await queryOne<{ x: number }>(
    `SELECT 1 AS x FROM sincronizaciones
      WHERE granularidad = 'MENSUAL' AND estado IN ('COMPLETADA', 'COMPLETADA_CON_ERRORES')
        AND id_inversor IS NULL AND id_proyecto IS NULL
        AND (detalle IS NULL OR detalle NOT LIKE '%"ambito":"SUBCONJUNTO"%')
        AND rango_desde <= ? AND rango_hasta >= ? AND finalizada_en >= ?
      LIMIT 1`,
    [`${anio}-01-01`, anio < anioActual ? `${anio}-12-31` : `${anio}-01-31`, desdeEjecucion],
  );
  return Boolean(fila);
}

/**
 * "Sincronizar ahora": trae TODO hasta este momento sin pedir fechas, gastando
 * del cupo de Huawei solo lo necesario.
 *
 *  0. Valida los inversores Huawei: enlaza a la integracion los que quedaron sin
 *     vincular y detecta los RECIEN AGREGADOS (sin ningun dato de Huawei).
 *  1. Diaria: el mes en curso siempre; el mes anterior solo si algun inversor aun
 *     no lo tiene cerrado (con su ultimo dia).
 *  2. Mensual de este anio y del anterior, solo si no se verifico recientemente.
 *  3. Historial completo de los inversores nuevos: mensual desde el inicio de su
 *     proyecto (o hasta 8 anios atras si no tiene fecha de inicio).
 *  4. Revisa que cada inversor Huawei haya quedado con datos y avisa los que no.
 *
 * Es seguro repetirlo: cada pasada actualiza los mismos registros y nunca los
 * suma de nuevo. Si Huawei corta por su limite de consultas, lo ya guardado se
 * conserva y se informa; volver a pulsar mas tarde continua donde quedo.
 */
export async function ejecutarSincronizacionAhora(usuario: {
  idUsuario: number | null;
  emailUsuario?: string | null;
}): Promise<ResultadoSincronizacionAhora> {
  const inicio = Date.now();

  const api = await queryOne<{ id_api: number; marca: string }>(
    `SELECT id_api, marca FROM apis_fabricante
      WHERE marca = 'HUAWEI' AND estado = 'ACTIVA' ORDER BY id_api LIMIT 1`,
  );
  if (!api) {
    throw errores.reglaNegocio(
      'No hay una integracion Huawei activa. Pida al administrador que la active en Integracion Huawei.',
    );
  }

  // 0. Validacion de inversores (incluye los recien agregados).
  const enlazados = await execute(
    `UPDATE inversores SET id_api = ?
      WHERE tipo_conexion = 'HUAWEI_API' AND activo = 1 AND serial_externo IS NOT NULL AND id_api IS NULL`,
    [api.id_api],
  );

  const hoy = hoyISO();
  const anio = Number(hoy.slice(0, 4));
  const mes = Number(hoy.slice(5, 7));
  const mesAnterior = mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
  const ultimoDiaPrevio = ultimoDiaMes(mesAnterior.anio, mesAnterior.mes);

  const inversores = await query<{
    id_inversor: number;
    serial_externo: string;
    proyecto: string;
    fecha_inicio: string | null;
    filas: number;
    cierra_mes_anterior: number;
  }>(
    `SELECT i.id_inversor, i.serial_externo, p.nombre AS proyecto, p.fecha_inicio,
            (SELECT COUNT(*) FROM produccion x
              WHERE x.id_inversor = i.id_inversor AND x.origen = 'HUAWEI_API' AND x.activo = 1) AS filas,
            (SELECT COUNT(*) FROM produccion x
              WHERE x.id_inversor = i.id_inversor AND x.origen = 'HUAWEI_API' AND x.activo = 1
                AND x.granularidad = 'DIARIA' AND x.fecha = ?) AS cierra_mes_anterior
       FROM inversores i JOIN proyectos p ON p.id_proyecto = i.id_proyecto
      WHERE i.tipo_conexion = 'HUAWEI_API' AND i.activo = 1 AND i.serial_externo IS NOT NULL AND i.id_api = ?`,
    [ultimoDiaPrevio, api.id_api],
  );
  if (inversores.length === 0) {
    throw errores.reglaNegocio(
      'No hay inversores Huawei activos con numero de serie. Registre o active inversores con conexion HUAWEI_API.',
    );
  }

  const nuevos = inversores.filter((i) => Number(i.filas) === 0);
  const necesitaMesAnterior = inversores.some(
    (i) =>
      Number(i.cierra_mes_anterior) === 0 && (!i.fecha_inicio || String(i.fecha_inicio).slice(0, 10) <= ultimoDiaPrevio),
  );

  const base = {
    idApi: api.id_api,
    tipo: 'MANUAL' as const,
    idUsuario: usuario.idUsuario,
    emailUsuario: usuario.emailUsuario ?? null,
  };
  const advertencias: string[] = [];
  const consultado: string[] = [];
  const ejecutadas: ResultadoSincronizacion[] = [];
  let completa = true;
  let limiteAlcanzado = false;
  let idSyncPrincipal = 0;
  let modo: 'MOCK' | 'REAL' = 'REAL';

  /** Ejecuta un tramo; ante el limite de Huawei corta los siguientes y conserva lo ya guardado. */
  const tramo = async (
    descripcion: string,
    parametros: Parameters<typeof ejecutarSincronizacion>[0],
    esPrincipal = false,
  ): Promise<void> => {
    if (limiteAlcanzado) return;
    try {
      const r = await ejecutarSincronizacion(parametros);
      ejecutadas.push(r);
      modo = r.modo;
      if (esPrincipal) idSyncPrincipal = r.id_sync;
      if (r.estado !== 'COMPLETADA') completa = false;
      advertencias.push(...r.advertencias);
      consultado.push(descripcion);
    } catch (error) {
      completa = false;
      if (error instanceof AppError && error.codigo === 'LIMITE_API') {
        limiteAlcanzado = true;
        advertencias.push(
          `Huawei alcanzo su limite de consultas durante "${descripcion}". Lo ya cargado se conservo; vuelva a pulsar el boton mas tarde (el cupo se renueva) y continuara donde quedo.`,
        );
        return;
      }
      if (esPrincipal) throw error;
      const motivo = error instanceof Error ? error.message : 'error desconocido';
      advertencias.push(`No se pudo completar "${descripcion}": ${motivo}`);
    }
  };

  // 1. Diaria: mes en curso siempre; el anterior solo si falta cerrarlo.
  const desdeDiario = necesitaMesAnterior
    ? primerDiaMes(mesAnterior.anio, mesAnterior.mes)
    : primerDiaMes(anio, mes);
  await tramo(
    necesitaMesAnterior ? 'diario del mes anterior y el actual' : 'diario del mes actual',
    { ...base, desde: desdeDiario, hasta: hoy, granularidad: 'DIARIA' },
    true,
  );

  // 2. Mensual de este anio y del anterior, solo si no se verifico recientemente.
  const aniosPendientes: number[] = [];
  for (const a of [anio - 1, anio]) {
    if (!(await anioMensualVerificado(a, anio))) aniosPendientes.push(a);
  }
  if (aniosPendientes.length > 0) {
    const primero = Math.min(...aniosPendientes);
    const incluyeActual = aniosPendientes.includes(anio);
    await tramo(`mensual ${primero}${incluyeActual && primero !== anio ? `-${anio}` : ''}`, {
      ...base,
      desde: `${primero}-01-01`,
      hasta: incluyeActual ? hoy : `${anio - 1}-12-31`,
      granularidad: 'MENSUAL',
    });
  }

  // 3. Historial completo de los inversores recien agregados.
  const proyectosNuevos = [...new Set(nuevos.map((n) => n.proyecto))];
  if (nuevos.length > 0) {
    const anioInicio = Math.max(
      anio - 8,
      Math.min(...nuevos.map((n) => (n.fecha_inicio ? Number(String(n.fecha_inicio).slice(0, 4)) : anio - 8))),
    );
    // Lo que el tramo 2 ya trajo para todos no se repite.
    const hastaHistorial = aniosPendientes.length > 0 ? `${Math.min(...aniosPendientes) - 1}-12-31` : hoy;
    if (`${anioInicio}-01-01` <= hastaHistorial) {
      await tramo(
        `historial de proyectos nuevos desde ${anioInicio}`,
        {
          ...base,
          idsInversores: nuevos.map((n) => n.id_inversor),
          desde: `${anioInicio}-01-01`,
          hasta: hastaHistorial,
          granularidad: 'MENSUAL',
        },
      );
    }
  }

  // 4. Cada inversor Huawei debe haber quedado con datos.
  const sinDatos = await query<{ serial_externo: string; proyecto: string }>(
    `SELECT i.serial_externo, p.nombre AS proyecto
       FROM inversores i JOIN proyectos p ON p.id_proyecto = i.id_proyecto
      WHERE i.tipo_conexion = 'HUAWEI_API' AND i.activo = 1 AND i.serial_externo IS NOT NULL AND i.id_api = ?
        AND NOT EXISTS (SELECT 1 FROM produccion x
                         WHERE x.id_inversor = i.id_inversor AND x.origen = 'HUAWEI_API' AND x.activo = 1)`,
    [api.id_api],
  );
  const inversoresSinDatos = sinDatos.map((i) => `${i.proyecto} (${i.serial_externo})`);
  if (!limiteAlcanzado) {
    for (const i of sinDatos) {
      advertencias.push(
        `El inversor ${i.serial_externo} del proyecto ${i.proyecto} no devolvio datos de Huawei: verifique que el serial sea correcto y pertenezca a la cuenta Northbound.`,
      );
    }
  }

  const sum = (campo: 'insertadas' | 'actualizadas' | 'rechazadas' | 'pendientesTarifa' | 'filasRecibidas') =>
    ejecutadas.reduce((total, r) => total + r[campo], 0);
  const rechazadas = sum('rechazadas');
  if (rechazadas > 0 || (inversoresSinDatos.length > 0 && !limiteAlcanzado)) completa = false;
  const insertadas = sum('insertadas');
  const actualizadas = sum('actualizadas');
  const pendientesTarifa = sum('pendientesTarifa');

  return {
    id_sync: idSyncPrincipal,
    estado: completa ? 'COMPLETADA' : 'COMPLETADA_CON_ERRORES',
    modo,
    filasRecibidas: sum('filasRecibidas'),
    insertadas,
    actualizadas,
    rechazadas,
    pendientesTarifa,
    duracionMs: Date.now() - inicio,
    advertencias: advertencias.slice(0, 50),
    desde: desdeDiario,
    hasta: hoy,
    proyectosNuevos: limiteAlcanzado ? [] : proyectosNuevos,
    inversoresSinDatos: limiteAlcanzado ? [] : inversoresSinDatos,
    limiteAlcanzado,
    consultado,
    mensaje: limiteAlcanzado
      ? `Huawei alcanzo su limite de consultas: se guardaron ${insertadas} registro(s) nuevo(s) y ${actualizadas} actualizado(s). ` +
        'Vuelva a pulsar el boton mas tarde para continuar.'
      : `Sincronizacion al momento finalizada: ${insertadas} registro(s) nuevo(s) y ${actualizadas} actualizado(s) hasta el ${hoy}.` +
        (enlazados.affectedRows > 0 ? ` Se vincularon ${enlazados.affectedRows} inversor(es) a la integracion.` : '') +
        (proyectosNuevos.length > 0
          ? ` Proyecto(s) nuevo(s) validado(s) con su historial: ${proyectosNuevos.join(', ')}.`
          : '') +
        (pendientesTarifa > 0 ? ` ${pendientesTarifa} registro(s) quedaron pendientes de tarifa.` : ''),
  };
}
