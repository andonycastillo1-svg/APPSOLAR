import { execute, query, queryOne, withTransaction } from '../db/pool';
import { AppError, errores } from '../utils/errors';
import { logger } from '../config/logger';
import { conBloqueo } from './bloqueos';
import { obtenerProduccion, type ConfiguracionAdaptador } from './huaweiCliente';
import { CacheTarifas, calcularValorizacion, mesEstaCerrado } from './valorizacion';
import { registrarAuditoria } from './auditoria';
import { hoyISO } from '../utils/fechas';

export interface ParametrosSincronizacion {
  idApi: number;
  idProyecto?: number | null;
  idInversor?: number | null;
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

  const recurso = `sync:huawei:${parametros.idApi}:${parametros.idProyecto ?? 'all'}:${parametros.idInversor ?? 'all'}`;

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
          parametros.desde,
          parametros.hasta,
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
          desde: parametros.desde,
          hasta: parametros.hasta,
          granularidad: parametros.granularidad,
        });

        const porSerial = new Map(inversores.map((i) => [i.serial_externo.toLowerCase(), i]));
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
            JSON.stringify({ advertencias: advertencias.slice(0, 50), pendientesTarifa }),
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
