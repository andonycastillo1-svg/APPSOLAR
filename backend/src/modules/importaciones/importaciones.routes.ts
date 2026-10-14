import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction } from '../../db/pool';
import { errores } from '../../utils/errors';
import {
  asyncHandler,
  consulta,
  esquemaPaginacion,
  limitesPaginacion,
  metaPaginacion,
  ok,
  validarConsulta,
  validarCuerpo,
} from '../../utils/http';
import { requiereAutenticacion, requierePermiso } from '../../middleware/autenticacion';
import { PERMISOS } from '../../config/permisos';
import { auditarDesdeRequest } from '../../services/auditoria';
import {
  crearSubidor,
  eliminarLotePreparado,
  guardarLotePreparado,
  leerLotePreparado,
  validarYGuardar,
} from '../../services/archivos';
import {
  agruparPorPeriodo,
  leerArchivo,
  plantillaConErroresCsv,
  plantillaHistoricaCsv,
  plantillaNormalizadaCsv,
  plantillaPlantaCompletaXlsx,
  plantillaXlsx,
  type FilaCanonica,
  type ProblemaFila,
} from '../../services/etl';
import { CacheTarifas, calcularValorizacion, exigirMesAbierto } from '../../services/valorizacion';
import { obtenerNumero } from '../../services/configuracion';
import { MESES_ES, anioActual, hoyISO } from '../../utils/fechas';
import { redondearKwh } from '../../utils/numeros';

export const importacionesRouter = Router();
const subidor = crearSubidor();

// ---------------------------------------------------------------------------
// Plantillas y archivo de ejemplo con errores  (GET /imports/template)
// ---------------------------------------------------------------------------
importacionesRouter.get(
  '/template',
  requiereAutenticacion,
  requierePermiso(PERMISOS.IMPORTACIONES_VER),
  validarConsulta(
    z.object({
      formato: z.enum(['NORMALIZADO', 'HISTORICO_EXCEL', 'PLANTA_COMPLETA']).default('HISTORICO_EXCEL'),
      tipo: z.enum(['csv', 'xlsx', 'errores']).default('xlsx'),
      id_proyecto: z.coerce.number().int().positive().optional(),
      anio: z.coerce.number().int().min(2000).max(2100).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { formato, tipo, id_proyecto, anio } = consulta<{
      formato: 'NORMALIZADO' | 'HISTORICO_EXCEL' | 'PLANTA_COMPLETA';
      tipo: string;
      id_proyecto?: number;
      anio?: number;
    }>(req);

    // Plantilla ya rellenada con los grupos e inversores reales de la planta.
    if (formato === 'PLANTA_COMPLETA') {
      if (!id_proyecto) {
        throw errores.validacion('Seleccione el proyecto (planta) para generar su plantilla completa.');
      }
      const proyecto = await queryOne<{ nombre: string }>(
        'SELECT nombre FROM proyectos WHERE id_proyecto = ? AND activo = 1',
        [id_proyecto],
      );
      if (!proyecto) throw errores.noEncontrado('el proyecto indicado');

      const gruposDb = await query<{ id_grupo: number; nombre: string }>(
        'SELECT id_grupo, nombre FROM grupos WHERE id_proyecto = ? AND activo = 1 ORDER BY nombre',
        [id_proyecto],
      );
      if (gruposDb.length === 0) {
        throw errores.reglaNegocio(
          'El proyecto no tiene grupos activos. Cree al menos un grupo antes de generar la plantilla.',
        );
      }
      const inversoresDb = await query<{
        id_grupo: number;
        serial_externo: string;
        marca: string;
        modelo: string;
      }>(
        `SELECT id_grupo, serial_externo, marca, modelo FROM inversores
          WHERE id_proyecto = ? AND activo = 1 AND serial_externo IS NOT NULL
          ORDER BY id_grupo, serial_externo`,
        [id_proyecto],
      );

      const anioPlantilla = anio ?? anioActual();
      const hoy = hoyISO();
      const hastaMes = anioPlantilla === Number(hoy.slice(0, 4)) ? Number(hoy.slice(5, 7)) : 12;

      const buffer = await plantillaPlantaCompletaXlsx({
        planta: proyecto.nombre,
        anio: anioPlantilla,
        hastaMes,
        grupos: gruposDb.map((g) => ({
          nombre: g.nombre,
          inversores: inversoresDb
            .filter((i) => i.id_grupo === g.id_grupo)
            .map((i) => ({ serial: i.serial_externo, equipo: `${i.marca} ${i.modelo}` })),
        })),
      });

      const nombreSeguro = normalizarNombre(proyecto.nombre).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="plantilla_planta_${nombreSeguro || 'proyecto'}_${anioPlantilla}.xlsx"`,
      );
      res.send(buffer);
      return;
    }

    if (tipo === 'errores') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ejemplo_con_errores.csv"');
      res.send(plantillaConErroresCsv());
      return;
    }

    if (tipo === 'csv') {
      const contenido =
        formato === 'NORMALIZADO' ? plantillaNormalizadaCsv() : plantillaHistoricaCsv();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="plantilla_${formato.toLowerCase()}.csv"`,
      );
      res.send('﻿' + contenido);
      return;
    }

    const buffer = await plantillaXlsx(formato as 'NORMALIZADO' | 'HISTORICO_EXCEL');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="plantilla_${formato.toLowerCase()}.xlsx"`,
    );
    res.send(buffer);
  }),
);

importacionesRouter.use(requiereAutenticacion);

// ---------------------------------------------------------------------------
// Utilidades de resolucion
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92);
function normalizarNombre(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(new RegExp('[' + BS + 'u0300-' + BS + 'u036f]', 'g'), '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

interface LotePreparado {
  formato: 'NORMALIZADO' | 'HISTORICO_EXCEL';
  filas: FilaCanonica[];
  problemas: ProblemaFila[];
  idProyectoFijo: number | null;
  idGrupoFijo: number | null;
  idInversorFijo: number | null;
  resolucionPlantas: Record<string, number | null>;
  resolucionSeriales: Record<string, number | null>;
  /** `planta|grupo` normalizado -> id del grupo (solo formato historico con columna Grupo). */
  resolucionGrupos: Record<string, number | null>;
  /** id del inversor -> id de su grupo, para no volver a consultarlo al confirmar. */
  grupoDeInversor: Record<number, number>;
  totalFilasLeidas: number;
}

const claveGrupo = (planta: string | null, grupo: string): string =>
  `${normalizarNombre(planta ?? '')}|${normalizarNombre(grupo)}`;

/**
 * Cuando Huawei ya entrego la produccion de un inversor en ese periodo, una
 * carga manual del mismo equipo se SUMARIA a la sincronizada. Para no duplicar
 * energia, esas filas se omiten (mensual: el mes; diaria: el dia exacto).
 */
async function huaweiYaCubre(
  idInversor: number,
  fila: { anio: number; mes: number; fecha: string; granularidad: 'DIARIA' | 'MENSUAL' },
  conn?: import('mysql2/promise').PoolConnection,
): Promise<boolean> {
  const existente =
    fila.granularidad === 'DIARIA'
      ? await queryOne(
          `SELECT 1 AS x FROM produccion WHERE id_inversor = ? AND origen = 'HUAWEI_API'
              AND activo = 1 AND fecha = ? LIMIT 1`,
          [idInversor, fila.fecha],
          conn,
        )
      : await queryOne(
          `SELECT 1 AS x FROM produccion WHERE id_inversor = ? AND origen = 'HUAWEI_API'
              AND activo = 1 AND anio = ? AND mes = ? LIMIT 1`,
          [idInversor, fila.anio, fila.mes],
          conn,
        );
  return Boolean(existente);
}

// ---------------------------------------------------------------------------
// POST /imports/preview
// ---------------------------------------------------------------------------
importacionesRouter.post(
  '/preview',
  requierePermiso(PERMISOS.IMPORTACIONES_CARGAR),
  subidor.single('archivo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw errores.solicitudInvalida('Debe adjuntar un archivo en el campo "archivo".');
    }

    const idProyecto = req.body.id_proyecto ? Number(req.body.id_proyecto) : null;
    // El grupo permite cargar un archivo del grupo completo cuando el
    // fabricante no entrego los datos de ese rango por fallas de conexion.
    const idGrupoSolicitado = req.body.id_grupo ? Number(req.body.id_grupo) : null;
    const idInversor = req.body.id_inversor ? Number(req.body.id_inversor) : null;
    const anioForzado = req.body.anio ? Number(req.body.anio) : undefined;

    const archivo = validarYGuardar(req.file);
    const maxFilas = await obtenerNumero('carga.filas_max', 20000);

    let serialUnico: string | null = null;
    let proyectoDelInversor: number | null = null;
    let idGrupoFijo: number | null = idGrupoSolicitado;

    if (idInversor) {
      const inversor = await queryOne<{
        id_proyecto: number;
        id_grupo: number;
        serial_externo: string | null;
      }>(
        'SELECT id_proyecto, id_grupo, serial_externo FROM inversores WHERE id_inversor = ? AND activo = 1',
        [idInversor],
      );
      if (!inversor) throw errores.validacion('El inversor seleccionado no existe o esta inactivo.');
      serialUnico = inversor.serial_externo;
      proyectoDelInversor = inversor.id_proyecto;
      // El grupo se hereda del inversor para mantener la jerarquia coherente.
      idGrupoFijo = inversor.id_grupo;
    } else if (idGrupoSolicitado) {
      const grupo = await queryOne<{ id_proyecto: number; activo: number }>(
        'SELECT id_proyecto, activo FROM grupos WHERE id_grupo = ?',
        [idGrupoSolicitado],
      );
      if (!grupo) throw errores.validacion('El grupo seleccionado no existe.');
      if (!grupo.activo) throw errores.reglaNegocio('El grupo seleccionado esta desactivado.');
      if (idProyecto && grupo.id_proyecto !== idProyecto) {
        throw errores.validacion('El grupo seleccionado no pertenece al proyecto indicado.');
      }
      proyectoDelInversor = grupo.id_proyecto;
    }

    const lectura = await leerArchivo(archivo.contenido, archivo.extension, {
      anioForzado,
      serialUnico,
      maxFilas,
    });

    const problemas = [...lectura.problemas];

    // --- Resolucion de plantas -> proyectos -----------------------------
    const resolucionPlantas: Record<string, number | null> = {};
    const plantasNoResueltas: string[] = [];

    if (lectura.formato === 'HISTORICO_EXCEL') {
      const proyectos = await query<{ id_proyecto: number; nombre: string; tipo_proyecto: string }>(
        'SELECT id_proyecto, nombre, tipo_proyecto FROM proyectos WHERE activo = 1',
      );
      const indice = new Map(proyectos.map((p) => [normalizarNombre(p.nombre), p]));
      const plantas = [...new Set(lectura.filas.map((f) => f.planta).filter(Boolean) as string[])];

      for (const planta of plantas) {
        const encontrado = indice.get(normalizarNombre(planta));
        resolucionPlantas[planta] = encontrado ? encontrado.id_proyecto : null;
        if (!encontrado) plantasNoResueltas.push(planta);
      }
    } else if (idProyecto || proyectoDelInversor) {
      resolucionPlantas['__fijo__'] = idProyecto ?? proyectoDelInversor;
    } else {
      throw errores.validacion(
        'Para el formato normalizado debe seleccionar el proyecto (y opcionalmente el inversor) antes de cargar el archivo.',
      );
    }

    // --- Resolucion de seriales -> inversores ---------------------------
    const resolucionSeriales: Record<string, number | null> = {};
    const serialesNoResueltos: string[] = [];
    const seriales = [...new Set(lectura.filas.map((f) => f.serial).filter(Boolean) as string[])];

    const infoInversor = new Map<number, { id_proyecto: number; id_grupo: number }>();
    if (seriales.length > 0) {
      const inversores = await query<{
        id_inversor: number;
        serial_externo: string;
        id_proyecto: number;
        id_grupo: number;
      }>(
        `SELECT id_inversor, serial_externo, id_proyecto, id_grupo FROM inversores
          WHERE activo = 1 AND serial_externo IS NOT NULL`,
      );
      const indice = new Map(inversores.map((i) => [normalizarNombre(i.serial_externo), i]));
      for (const i of inversores) infoInversor.set(i.id_inversor, { id_proyecto: i.id_proyecto, id_grupo: i.id_grupo });
      for (const serial of seriales) {
        const encontrado = indice.get(normalizarNombre(serial));
        resolucionSeriales[serial] = encontrado ? encontrado.id_inversor : null;
        if (!encontrado) serialesNoResueltos.push(serial);
      }
    }

    // --- Resolucion de grupos y coherencia planta / grupo / inversor -----
    // Plantilla de planta completa: cada fila debe apuntar a un grupo e
    // inversor reales de ESA planta. Las filas incoherentes se descartan con
    // su motivo (carga parcial) en lugar de cargarse en un destino equivocado.
    const resolucionGrupos: Record<string, number | null> = {};
    if (lectura.formato === 'HISTORICO_EXCEL') {
      const gruposDb = await query<{ id_grupo: number; id_proyecto: number; nombre: string; activo: number }>(
        'SELECT id_grupo, id_proyecto, nombre, activo FROM grupos',
      );
      const indiceGrupos = new Map(gruposDb.map((g) => [`${g.id_proyecto}|${normalizarNombre(g.nombre)}`, g]));
      const descartadas = new Set<number>();
      const descartar = (fila: FilaCanonica, columna: string, valor: string | null, codigo: string, mensaje: string) => {
        descartadas.add(fila.fila);
        problemas.push({ fila: fila.fila, columna, valor, codigo, severidad: 'ERROR', mensaje });
      };

      for (const fila of lectura.filas) {
        const idProyFila = resolucionPlantas[fila.planta ?? ''];
        if (!idProyFila) continue;

        let idGrupoFila: number | null = null;
        if (fila.grupo) {
          const g = indiceGrupos.get(`${idProyFila}|${normalizarNombre(fila.grupo)}`);
          if (!g) {
            descartar(fila, 'Grupo', fila.grupo, 'GRUPO_NO_ENCONTRADO',
              `El grupo "${fila.grupo}" no existe en la planta "${fila.planta}".`);
            continue;
          }
          if (!g.activo) {
            descartar(fila, 'Grupo', fila.grupo, 'GRUPO_INACTIVO', `El grupo "${fila.grupo}" esta desactivado.`);
            continue;
          }
          idGrupoFila = g.id_grupo;
          resolucionGrupos[claveGrupo(fila.planta, fila.grupo)] = g.id_grupo;
        }

        if (fila.serial) {
          const idInv = resolucionSeriales[fila.serial];
          if (idInv) {
            const inv = infoInversor.get(idInv)!;
            if (inv.id_proyecto !== idProyFila) {
              descartar(fila, 'Inversor', fila.serial, 'INVERSOR_FUERA_DE_PROYECTO',
                `El inversor "${fila.serial}" no pertenece a la planta "${fila.planta}".`);
            } else if (idGrupoFila && inv.id_grupo !== idGrupoFila) {
              descartar(fila, 'Inversor', fila.serial, 'INVERSOR_FUERA_DE_GRUPO',
                `El inversor "${fila.serial}" no pertenece al grupo "${fila.grupo}".`);
            }
          } else if (fila.grupo) {
            descartar(fila, 'Inversor', fila.serial, 'SERIAL_NO_ENCONTRADO',
              `El inversor "${fila.serial}" no esta registrado; la fila no se carga para no asignarla a un destino equivocado.`);
          }
        }
      }
      if (descartadas.size > 0) lectura.filas = lectura.filas.filter((f) => !descartadas.has(f.fila));
    }

    // --- Agrupacion y deteccion de grupos que requieren decision --------
    const grupos = agruparPorPeriodo(lectura.filas);
    const gruposConDecision = grupos.filter((g) => g.requiereDecision);

    // --- Deteccion de duplicados contra la base -------------------------
    const duplicados: Array<{ fila: number; motivo: string }> = [];
    for (const fila of lectura.filas) {
      const idProyectoFila =
        lectura.formato === 'HISTORICO_EXCEL'
          ? resolucionPlantas[fila.planta ?? '']
          : (idProyecto ?? proyectoDelInversor);
      if (!idProyectoFila) continue;

      const idInversorFila = fila.serial ? resolucionSeriales[fila.serial] : idInversor;
      const idGrupoFilaPrev = idInversorFila
        ? (infoInversor.get(idInversorFila)?.id_grupo ?? null)
        : fila.grupo
          ? (resolucionGrupos[claveGrupo(fila.planta, fila.grupo)] ?? null)
          : idGrupoFijo;

      // Energia ya sincronizada desde Huawei para ese equipo y periodo.
      if (idInversorFila && (await huaweiYaCubre(idInversorFila, fila))) {
        problemas.push({
          fila: fila.fila,
          columna: 'Inversor',
          valor: fila.serial,
          codigo: 'YA_SINCRONIZADO_HUAWEI',
          severidad: 'ADVERTENCIA',
          mensaje:
            `Huawei ya entrego la produccion de este inversor en ${MESES_ES[fila.mes - 1]} ${fila.anio}. ` +
            'La fila se omitira al confirmar para no duplicar la energia.',
        });
        continue;
      }

      const existente = await queryOne<{ id_produccion: number; kwh: number }>(
        `SELECT id_produccion, kwh FROM produccion
          WHERE id_proyecto = ? AND COALESCE(id_inversor, 0) = ? AND COALESCE(id_grupo, 0) = ?
            AND fecha = ? AND granularidad = ? AND origen = 'MANUAL' AND secuencia = 0 AND activo = 1`,
        [idProyectoFila, idInversorFila ?? 0, idGrupoFilaPrev ?? 0, fila.fecha, fila.granularidad],
      );
      if (existente) {
        duplicados.push({
          fila: fila.fila,
          motivo: `Ya existe un registro para ese periodo con ${existente.kwh} kWh.`,
        });
      }
    }

    // --- Mezcla de niveles de detalle -----------------------------------
    // Se evalua por destino (grupo): en una planta completa un grupo puede venir
    // por inversor y otro consolidado sin que eso sea un conflicto.
    const conflictosNivel: Array<{ proyecto: string; anio: number; mes: number; existente: string; entrante: string }> = [];
    for (const grupo of grupos) {
      const idProyectoGrupo =
        lectura.formato === 'HISTORICO_EXCEL'
          ? resolucionPlantas[grupo.planta]
          : (idProyecto ?? proyectoDelInversor);
      if (!idProyectoGrupo) continue;

      const destinos = new Map<string, { nivel: string; idGrupo: number | null }>();
      for (const fila of grupo.filas) {
        const idInvFila = fila.serial ? resolucionSeriales[fila.serial] : idInversor;
        const idGrupoDestino = idInvFila
          ? (infoInversor.get(idInvFila)?.id_grupo ?? idGrupoFijo)
          : fila.grupo
            ? (resolucionGrupos[claveGrupo(fila.planta, fila.grupo)] ?? null)
            : idGrupoFijo;
        const nivel = idInvFila ? 'POR_INVERSOR' : idGrupoDestino ? 'GRUPO_CONSOLIDADO' : 'PROYECTO_CONSOLIDADO';
        destinos.set(`${nivel}|${idGrupoDestino ?? 0}`, { nivel, idGrupo: idGrupoDestino });
      }

      for (const destino of destinos.values()) {
        const existente = await queryOne<{ nivel_detalle: string }>(
          `SELECT DISTINCT nivel_detalle FROM produccion
            WHERE id_proyecto = ? AND anio = ? AND mes = ? AND activo = 1 AND nivel_detalle <> ?
              AND (? IS NULL OR id_grupo = ? OR id_grupo IS NULL)`,
          [idProyectoGrupo, grupo.anio, grupo.mes, destino.nivel, destino.idGrupo, destino.idGrupo],
        );
        if (existente) {
          conflictosNivel.push({
            proyecto: grupo.planta || String(idProyectoGrupo),
            anio: grupo.anio,
            mes: grupo.mes,
            existente: existente.nivel_detalle,
            entrante: destino.nivel,
          });
          break;
        }
      }
    }

    // --- Periodos cerrados ----------------------------------------------
    const periodosCerrados: Array<{ proyecto: string; anio: number; mes: number }> = [];
    for (const grupo of grupos) {
      const idProyectoGrupo =
        lectura.formato === 'HISTORICO_EXCEL'
          ? resolucionPlantas[grupo.planta]
          : (idProyecto ?? proyectoDelInversor);
      if (!idProyectoGrupo) continue;
      const cierre = await queryOne<{ estado: string }>(
        'SELECT estado FROM cierres_mensuales WHERE id_proyecto = ? AND anio = ? AND mes = ?',
        [idProyectoGrupo, grupo.anio, grupo.mes],
      );
      if (cierre?.estado === 'CERRADO') {
        periodosCerrados.push({ proyecto: grupo.planta, anio: grupo.anio, mes: grupo.mes });
      }
    }

    // --- Cobertura tarifaria estimada del lote --------------------------
    const cacheTarifas = new CacheTarifas();
    const mesesSinTarifa: Array<{ proyecto: string; anio: number; mes: number }> = [];
    for (const grupo of grupos) {
      const idProyectoGrupo =
        lectura.formato === 'HISTORICO_EXCEL'
          ? resolucionPlantas[grupo.planta]
          : (idProyecto ?? proyectoDelInversor);
      if (!idProyectoGrupo) continue;
      const tarifa = await cacheTarifas.obtener(idProyectoGrupo, grupo.anio, grupo.mes);
      if (!tarifa) {
        mesesSinTarifa.push({ proyecto: grupo.planta, anio: grupo.anio, mes: grupo.mes });
      }
    }

    for (const planta of plantasNoResueltas) {
      problemas.push({
        fila: 0,
        columna: 'Planta',
        valor: planta,
        codigo: 'PLANTA_NO_ENCONTRADA',
        severidad: 'ERROR',
        mensaje: `La planta "${planta}" no coincide con ningun proyecto registrado. Asignela manualmente o creela antes de confirmar.`,
      });
    }
    for (const serial of serialesNoResueltos) {
      problemas.push({
        fila: 0,
        columna: 'Inversor',
        valor: serial,
        codigo: 'SERIAL_NO_ENCONTRADO',
        severidad: 'ADVERTENCIA',
        mensaje: `El identificador "${serial}" no corresponde a ningun inversor registrado. Las filas se cargaran como consolidado del proyecto si no lo resuelve.`,
      });
    }

    const nivelDetalleLote =
      seriales.length > 0 || idInversor
        ? 'POR_INVERSOR'
        : idGrupoFijo
          ? 'GRUPO_CONSOLIDADO'
          : 'PROYECTO_CONSOLIDADO';

    const errores_ = problemas.filter((p) => p.severidad === 'ERROR');
    const advertencias = problemas.filter((p) => p.severidad === 'ADVERTENCIA');

    // --- Registro del lote en `historicos` ------------------------------
    const resultado = await execute(
      `INSERT INTO historicos
         (id_proyecto, id_grupo, id_inversor, formato, nivel_detalle, nombre_archivo_original,
          nombre_archivo_seguro, hash_sha256, tamano_bytes, mime_detectado, id_usuario,
          estado, total_filas, rechazadas, advertencias, duplicadas, fecha_min, fecha_max, resumen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALIDADO', ?, ?, ?, ?, ?, ?, ?)`,
      [
        idProyecto ?? proyectoDelInversor,
        idGrupoFijo,
        idInversor,
        lectura.formato,
        nivelDetalleLote,
        archivo.nombreOriginal,
        archivo.nombreSeguro,
        archivo.hash,
        archivo.tamanoBytes,
        req.file.mimetype?.slice(0, 120) ?? null,
        req.usuario!.id_usuario,
        lectura.totalFilasLeidas,
        errores_.length,
        advertencias.length,
        duplicados.length,
        lectura.filas.length > 0 ? lectura.filas.reduce((a, f) => (f.fecha < a ? f.fecha : a), lectura.filas[0].fecha) : null,
        lectura.filas.length > 0 ? lectura.filas.reduce((a, f) => (f.fecha > a ? f.fecha : a), lectura.filas[0].fecha) : null,
        JSON.stringify({
          encabezados: lectura.encabezados,
          mapeoDetectado: lectura.mapeoDetectado,
          plantasNoResueltas,
          serialesNoResueltos,
        }),
      ],
    );
    const idHistorico = resultado.insertId;

    for (const problema of problemas.slice(0, 500)) {
      await execute(
        `INSERT INTO historico_errores (id_historico, fila, columna, valor, codigo, severidad, mensaje)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          idHistorico,
          problema.fila || null,
          problema.columna,
          problema.valor,
          problema.codigo,
          problema.severidad,
          problema.mensaje,
        ],
      );
    }

    const lote: LotePreparado = {
      formato: lectura.formato,
      filas: lectura.filas,
      problemas,
      idProyectoFijo: idProyecto ?? proyectoDelInversor,
      idGrupoFijo,
      idInversorFijo: idInversor,
      resolucionPlantas,
      resolucionSeriales,
      resolucionGrupos,
      grupoDeInversor: Object.fromEntries(
        [...infoInversor.entries()].map(([id, i]) => [id, i.id_grupo]),
      ),
      totalFilasLeidas: lectura.totalFilasLeidas,
    };
    guardarLotePreparado(idHistorico, lote);

    await auditarDesdeRequest(req, {
      accion: 'IMPORTACION_PREVISUALIZADA',
      entidad: 'historicos',
      idEntidad: idHistorico,
      despues: {
        archivo: archivo.nombreOriginal,
        hash: archivo.hash,
        formato: lectura.formato,
        filas: lectura.totalFilasLeidas,
      },
    });

    ok(res, {
      id_historico: idHistorico,
      formato: lectura.formato,
      id_grupo: idGrupoFijo,
      nivelDetalleLote,
      encabezados: lectura.encabezados,
      mapeoDetectado: lectura.mapeoDetectado,
      totales: {
        filasLeidas: lectura.totalFilasLeidas,
        validas: lectura.filas.length,
        errores: errores_.length,
        advertencias: advertencias.length,
        duplicados: duplicados.length,
      },
      // Muestra acotada para la previsualizacion.
      muestra: lectura.filas.slice(0, 100),
      grupos: grupos.map((g) => ({
        clave: g.clave,
        planta: g.planta,
        anio: g.anio,
        mes: g.mes,
        mesNombre: MESES_ES[g.mes - 1],
        filas: g.filas.length,
        kwhTotal: g.kwhTotal,
        tieneSerial: g.tieneSerial,
        requiereDecision: g.requiereDecision,
        numerosFila: g.filas.map((f) => f.fila),
        idProyectoResuelto:
          lectura.formato === 'HISTORICO_EXCEL'
            ? (resolucionPlantas[g.planta] ?? null)
            : (idProyecto ?? proyectoDelInversor),
      })),
      gruposQueRequierenDecision: gruposConDecision.map((g) => ({
        clave: g.clave,
        planta: g.planta,
        anio: g.anio,
        mes: g.mes,
        mesNombre: MESES_ES[g.mes - 1],
        filas: g.filas.length,
        kwhTotal: g.kwhTotal,
        opciones: [
          { valor: 'SUMAR', descripcion: 'Sumar las filas en un unico registro consolidado del proyecto.' },
          { valor: 'COMPONENTES', descripcion: 'Conservar cada fila como componente independiente del consolidado.' },
          { valor: 'MAPEAR', descripcion: 'Asignar cada fila a un inversor especifico (requiere mapeo por fila).' },
          { valor: 'RECHAZAR', descripcion: 'Rechazar el grupo para corregir el archivo.' },
        ],
      })),
      plantasNoResueltas,
      serialesNoResueltos,
      duplicados,
      conflictosNivelDetalle: conflictosNivel,
      periodosCerrados,
      mesesSinTarifaAprobada: mesesSinTarifa.map((m) => ({ ...m, mesNombre: MESES_ES[m.mes - 1] })),
      problemas: problemas.slice(0, 200),
      // Los errores de una fila NO ocultan ni bloquean los registros validos:
      // habilitan una carga parcial que el usuario debe confirmar de forma
      // explicita, sabiendo cuantas filas quedaran fuera.
      puedeConfirmar: plantasNoResueltas.length === 0 && periodosCerrados.length === 0,
      requiereConfirmarCargaParcial: errores_.length > 0,
      filasQueSeDescartaran: errores_.length,
      mensaje:
        plantasNoResueltas.length > 0
          ? `Hay ${plantasNoResueltas.length} planta(s) del archivo que no corresponden a ningun proyecto registrado. Asignelas antes de confirmar.`
          : periodosCerrados.length > 0
            ? `El archivo incluye ${periodosCerrados.length} periodo(s) cerrado(s). Solicite su reapertura antes de confirmar.`
            : errores_.length > 0
              ? `Se cargaran ${lectura.filas.length} fila(s) valida(s) y se descartaran ${errores_.length} fila(s) con error. Debe confirmar la carga parcial de forma explicita.`
              : 'Archivo validado sin errores. Revise el resumen y confirme la carga.',
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /imports/:id/confirm
// ---------------------------------------------------------------------------
const esquemaConfirmar = z.object({
  politicaDuplicados: z.enum(['OMITIR', 'ACTUALIZAR']).default('ACTUALIZAR'),
  decisiones: z.record(z.enum(['SUMAR', 'COMPONENTES', 'MAPEAR', 'RECHAZAR'])).default({}),
  mapeoPlantas: z.record(z.coerce.number().int().positive()).default({}),
  mapeoFilas: z.record(z.coerce.number().int().positive()).default({}),
  confirmarMezclaNiveles: z.boolean().default(false),
  aceptarCargaParcial: z.boolean().default(false),
});

importacionesRouter.post(
  '/:id/confirm',
  requierePermiso(PERMISOS.IMPORTACIONES_CARGAR),
  validarCuerpo(esquemaConfirmar),
  asyncHandler(async (req, res) => {
    const idHistorico = Number(req.params.id);
    const opciones = req.body as z.infer<typeof esquemaConfirmar>;

    const historico = await queryOne<{ estado: string; id_usuario: number; formato: string }>(
      'SELECT estado, id_usuario, formato FROM historicos WHERE id_historico = ?',
      [idHistorico],
    );
    if (!historico) throw errores.noEncontrado('la importacion indicada');
    if (historico.estado !== 'VALIDADO') {
      throw errores.reglaNegocio(
        `La importacion esta en estado ${historico.estado} y ya no puede confirmarse.`,
      );
    }

    const lote = leerLotePreparado<LotePreparado>(idHistorico);
    if (!lote) {
      await execute("UPDATE historicos SET estado = 'EXPIRADO' WHERE id_historico = ?", [idHistorico]);
      throw errores.reglaNegocio(
        'La previsualizacion expiro o fue eliminada. Vuelva a cargar el archivo.',
      );
    }

    // Carga parcial: si el archivo trajo filas con error, el usuario debe
    // aceptarlo expresamente para que se procesen unicamente las validas.
    const filasConError = lote.problemas.filter((p) => p.severidad === 'ERROR').length;
    if (filasConError > 0 && !opciones.aceptarCargaParcial) {
      throw errores.reglaNegocio(
        `El archivo tiene ${filasConError} fila(s) con error que quedaran fuera de la carga. ` +
          'Confirme expresamente la carga parcial o corrija el archivo y vuelva a previsualizarlo.',
        { filasConError, filasValidas: lote.filas.length },
      );
    }

    // Resolucion final de plantas (incluye las asignadas manualmente).
    const resolucion = { ...lote.resolucionPlantas, ...opciones.mapeoPlantas };
    const grupos = agruparPorPeriodo(lote.filas);

    const idProyectoDe = (planta: string | null): number | null => {
      if (lote.formato === 'NORMALIZADO') return lote.idProyectoFijo;
      if (!planta) return null;
      return resolucion[planta] ?? null;
    };

    // Validaciones previas al inicio de la transaccion.
    const sinResolver = grupos.filter((g) => !idProyectoDe(g.planta));
    if (sinResolver.length > 0) {
      throw errores.validacion(
        `Hay ${sinResolver.length} grupo(s) cuya planta no esta asignada a un proyecto. Resuelva las asignaciones antes de confirmar.`,
        { plantas: [...new Set(sinResolver.map((g) => g.planta))] },
      );
    }

    for (const grupo of grupos) {
      if (opciones.decisiones[grupo.clave] === 'RECHAZAR') continue;
      const idProyecto = idProyectoDe(grupo.planta)!;
      await exigirMesAbierto(idProyecto, grupo.anio, grupo.mes);

      if (grupo.requiereDecision && !opciones.decisiones[grupo.clave]) {
        throw errores.reglaNegocio(
          `El grupo ${grupo.planta} ${MESES_ES[grupo.mes - 1]} ${grupo.anio} tiene ${grupo.filas.length} filas sin identificador de inversor. Debe indicar que hacer con el (SUMAR, COMPONENTES, MAPEAR o RECHAZAR).`,
          { clave: grupo.clave },
        );
      }
    }

    // Prevencion de doble conteo entre consolidado y detalle por inversor.
    // Se evalua por destino (grupo): grupos distintos de una misma planta pueden
    // venir en niveles distintos sin duplicar energia.
    const destinoDeFila = (fila: FilaCanonica, decision: string | undefined) => {
      const idInv =
        decision === 'MAPEAR'
          ? (opciones.mapeoFilas[String(fila.fila)] ?? null)
          : fila.serial
            ? (lote.resolucionSeriales[fila.serial] ?? null)
            : lote.idInversorFijo;
      const idGrupoDestino = idInv
        ? (lote.grupoDeInversor[idInv] ?? lote.idGrupoFijo)
        : fila.grupo
          ? (lote.resolucionGrupos[claveGrupo(fila.planta, fila.grupo)] ?? null)
          : lote.idGrupoFijo;
      const nivel = idInv ? 'POR_INVERSOR' : idGrupoDestino ? 'GRUPO_CONSOLIDADO' : 'PROYECTO_CONSOLIDADO';
      return { idInv, idGrupoDestino, nivel };
    };

    if (!opciones.confirmarMezclaNiveles) {
      for (const grupo of grupos) {
        if (opciones.decisiones[grupo.clave] === 'RECHAZAR') continue;
        const idProyecto = idProyectoDe(grupo.planta)!;
        const decision = opciones.decisiones[grupo.clave];

        const destinos = new Map<string, { nivel: string; idGrupo: number | null }>();
        for (const fila of grupo.filas) {
          const d = destinoDeFila(fila, decision);
          const nivel = decision === 'SUMAR' ? (lote.idGrupoFijo ? 'GRUPO_CONSOLIDADO' : 'PROYECTO_CONSOLIDADO') : d.nivel;
          const idGrupo = decision === 'SUMAR' ? lote.idGrupoFijo : d.idGrupoDestino;
          destinos.set(`${nivel}|${idGrupo ?? 0}`, { nivel, idGrupo });
        }

        for (const destino of destinos.values()) {
          const conflicto = await queryOne<{ nivel_detalle: string }>(
            `SELECT DISTINCT nivel_detalle FROM produccion
              WHERE id_proyecto = ? AND anio = ? AND mes = ? AND activo = 1 AND nivel_detalle <> ?
                AND (? IS NULL OR id_grupo = ? OR id_grupo IS NULL)`,
            [idProyecto, grupo.anio, grupo.mes, destino.nivel, destino.idGrupo, destino.idGrupo],
          );
          if (conflicto) {
            throw errores.reglaNegocio(
              `Para ${grupo.planta} en ${MESES_ES[grupo.mes - 1]} ${grupo.anio} ya existe produccion registrada como ${conflicto.nivel_detalle} y este lote es ${destino.nivel}. Mezclar ambos niveles duplicaria la energia. Revise el caso y confirme explicitamente si desea continuar.`,
              { clave: grupo.clave, existente: conflicto.nivel_detalle, entrante: destino.nivel },
            );
          }
        }
      }
    }

    await execute("UPDATE historicos SET estado = 'PROCESANDO' WHERE id_historico = ?", [idHistorico]);

    let insertadas = 0;
    let actualizadas = 0;
    let omitidas = 0;
    let rechazadas = 0;
    let pendientesTarifa = 0;
    const inversoresTocados = new Set<number>();
    const erroresProceso: ProblemaFila[] = [];

    try {
      await withTransaction(async (conn) => {
        const cache = new CacheTarifas(conn);

        for (const grupo of grupos) {
          const decision = opciones.decisiones[grupo.clave];
          if (decision === 'RECHAZAR') {
            rechazadas += grupo.filas.length;
            erroresProceso.push({
              fila: grupo.filas[0].fila,
              columna: null,
              valor: grupo.clave,
              codigo: 'GRUPO_RECHAZADO',
              severidad: 'ADVERTENCIA',
              mensaje: `El usuario rechazo el grupo ${grupo.planta} ${MESES_ES[grupo.mes - 1]} ${grupo.anio} (${grupo.filas.length} fila(s)).`,
            });
            continue;
          }

          const idProyecto = idProyectoDe(grupo.planta)!;

          /** Filas efectivas a insertar segun la decision tomada. */
          type Registro = {
            idInversor: number | null;
            /** Grupo destino ya resuelto para filas por grupo (sin inversor). */
            idGrupo: number | null;
            fechaFila: string;
            kwh: number;
            secuencia: number;
            comentarios: string | null;
            filaOrigen: number;
          };
          const registros: Registro[] = [];

          if (decision === 'SUMAR') {
            registros.push({
              idInversor: null,
              idGrupo: lote.idGrupoFijo,
              fechaFila: grupo.filas[0].fecha,
              kwh: grupo.kwhTotal,
              secuencia: 0,
              comentarios:
                grupo.filas
                  .map((f) => f.comentarios)
                  .filter(Boolean)
                  .join(' | ')
                  .slice(0, 500) || `Consolidado de ${grupo.filas.length} filas del archivo`,
              filaOrigen: grupo.filas[0].fila,
            });
          } else {
            // La secuencia distingue componentes REPETIDOS del mismo destino; no
            // depende del orden de las filas de otros grupos o equipos, de modo
            // que volver a cargar el archivo actualiza los mismos registros.
            const ordinalPorDestino = new Map<string, number>();
            grupo.filas.forEach((fila) => {
              let idInversor: number | null = null;
              if (decision === 'MAPEAR') {
                idInversor = opciones.mapeoFilas[String(fila.fila)] ?? null;
                if (!idInversor) {
                  erroresProceso.push({
                    fila: fila.fila,
                    columna: 'Inversor',
                    valor: null,
                    codigo: 'MAPEO_FALTANTE',
                    severidad: 'ERROR',
                    mensaje: 'Se eligio mapear el grupo pero esta fila no tiene inversor asignado.',
                  });
                  rechazadas += 1;
                  return;
                }
              } else if (fila.serial) {
                idInversor = lote.resolucionSeriales[fila.serial] ?? null;
              } else if (lote.idInversorFijo) {
                idInversor = lote.idInversorFijo;
              }

              const idGrupoFila = idInversor
                ? null
                : fila.grupo
                  ? (lote.resolucionGrupos[claveGrupo(fila.planta, fila.grupo)] ?? null)
                  : lote.idGrupoFijo;
              const destinoClave = `${idInversor ?? 0}|${idGrupoFila ?? 0}`;
              const ordinal = ordinalPorDestino.get(destinoClave) ?? 0;
              ordinalPorDestino.set(destinoClave, ordinal + 1);

              registros.push({
                idInversor,
                idGrupo: idGrupoFila,
                fechaFila: fila.fecha,
                kwh: fila.kwh,
                secuencia: ordinal,
                comentarios: fila.comentarios,
                filaOrigen: fila.fila,
              });
            });
          }

          // Cada registro necesita conocer su grupo: el del inversor cuando
          // se mapea a un equipo, o el grupo destino del lote en su defecto.
          const grupoDeInversor = new Map<number, number>();
          for (const registro of registros) {
            if (registro.idInversor && !grupoDeInversor.has(registro.idInversor)) {
              const enLote = lote.grupoDeInversor[registro.idInversor];
              const inv = enLote
                ? { id_grupo: enLote }
                : await queryOne<{ id_grupo: number }>(
                    'SELECT id_grupo FROM inversores WHERE id_inversor = ?',
                    [registro.idInversor],
                    conn,
                  );
              if (inv) grupoDeInversor.set(registro.idInversor, inv.id_grupo);
            }
          }

          for (const registro of registros) {
            const idGrupoRegistro = registro.idInversor
              ? (grupoDeInversor.get(registro.idInversor) ?? null)
              : registro.idGrupo;
            const nivel = registro.idInversor
              ? 'POR_INVERSOR'
              : idGrupoRegistro
                ? 'GRUPO_CONSOLIDADO'
                : 'PROYECTO_CONSOLIDADO';
            const fecha = `${grupo.anio}-${String(grupo.mes).padStart(2, '0')}-01`;
            const granularidad = grupo.filas[0].granularidad;
            const fechaReal = granularidad === 'DIARIA' ? grupo.filas[0].fecha : fecha;

            // Para el formato normalizado cada fila conserva su propia fecha.
            const filaOriginal = grupo.filas.find((f) => f.fila === registro.filaOrigen);
            const fechaFinal =
              granularidad === 'DIARIA' && filaOriginal ? filaOriginal.fecha : fechaReal;

            // Si Huawei ya entrego este equipo en el periodo, la fila manual se
            // omite: sumarla duplicaria la energia.
            if (
              registro.idInversor &&
              (await huaweiYaCubre(
                registro.idInversor,
                { anio: grupo.anio, mes: grupo.mes, fecha: fechaFinal, granularidad },
                conn,
              ))
            ) {
              omitidas += 1;
              erroresProceso.push({
                fila: registro.filaOrigen,
                columna: 'Inversor',
                valor: null,
                codigo: 'YA_SINCRONIZADO_HUAWEI',
                severidad: 'ADVERTENCIA',
                mensaje: `Huawei ya entrego la produccion de este inversor en ${MESES_ES[grupo.mes - 1]} ${grupo.anio}; la fila manual se omitio para no duplicar energia.`,
              });
              continue;
            }

            const valorizacion = await calcularValorizacion(
              idProyecto,
              grupo.anio,
              grupo.mes,
              registro.kwh,
              cache,
              conn,
            );
            if (valorizacion.estado_valorizacion === 'PENDIENTE_DE_TARIFA') pendientesTarifa += 1;

            const existente = await queryOne<{ id_produccion: number }>(
              `SELECT id_produccion FROM produccion
                WHERE id_proyecto = ? AND COALESCE(id_grupo, 0) = ?
                  AND COALESCE(id_inversor, 0) = ? AND fecha = ?
                  AND granularidad = ? AND origen = 'MANUAL' AND secuencia = ?`,
              [
                idProyecto,
                idGrupoRegistro ?? 0,
                registro.idInversor ?? 0,
                fechaFinal,
                granularidad,
                registro.secuencia,
              ],
              conn,
            );

            if (existente) {
              if (opciones.politicaDuplicados === 'OMITIR') {
                omitidas += 1;
                continue;
              }
              await execute(
                `UPDATE produccion
                    SET kwh = ?, id_tarifa = ?, costo_kwh_aplicado = ?, valor_q = ?,
                        estado_valorizacion = ?, comentarios = ?, id_historico = ?, updated_by = ?
                  WHERE id_produccion = ?`,
                [
                  registro.kwh,
                  valorizacion.id_tarifa,
                  valorizacion.costo_kwh_aplicado,
                  valorizacion.valor_q,
                  valorizacion.estado_valorizacion,
                  registro.comentarios,
                  idHistorico,
                  req.usuario!.id_usuario,
                  existente.id_produccion,
                ],
                conn,
              );
              actualizadas += 1;
            } else {
              await execute(
                `INSERT INTO produccion
                   (id_proyecto, id_inversor, id_grupo, nivel_detalle, fecha, anio, mes, granularidad,
                    kwh, origen, secuencia, id_historico, id_tarifa, costo_kwh_aplicado,
                    valor_q, estado_valorizacion, comentarios, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  idProyecto,
                  registro.idInversor,
                  idGrupoRegistro,
                  nivel,
                  fechaFinal,
                  grupo.anio,
                  grupo.mes,
                  granularidad,
                  registro.kwh,
                  registro.secuencia,
                  idHistorico,
                  valorizacion.id_tarifa,
                  valorizacion.costo_kwh_aplicado,
                  valorizacion.valor_q,
                  valorizacion.estado_valorizacion,
                  registro.comentarios,
                  req.usuario!.id_usuario,
                ],
                conn,
              );
              insertadas += 1;
            }

            if (registro.idInversor) inversoresTocados.add(registro.idInversor);
          }
        }

        // Se actualiza la fecha de produccion disponible por inversor.
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
    } catch (error) {
      await execute(
        "UPDATE historicos SET estado = 'FALLIDO', mensaje = ? WHERE id_historico = ?",
        [error instanceof Error ? error.message.slice(0, 500) : 'Error desconocido', idHistorico],
      );
      await auditarDesdeRequest(req, {
        accion: 'IMPORTACION_FALLIDA',
        entidad: 'historicos',
        idEntidad: idHistorico,
        resultado: 'FALLO',
        motivo: error instanceof Error ? error.message.slice(0, 400) : null,
      });
      throw error;
    }

    for (const problema of erroresProceso.slice(0, 500)) {
      await execute(
        `INSERT INTO historico_errores (id_historico, fila, columna, valor, codigo, severidad, mensaje)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [idHistorico, problema.fila, problema.columna, problema.valor, problema.codigo, problema.severidad, problema.mensaje],
      );
    }

    const estadoFinal = rechazadas > 0 || erroresProceso.some((e) => e.severidad === 'ERROR')
      ? 'COMPLETADO_CON_ERRORES'
      : 'COMPLETADO';

    await execute(
      `UPDATE historicos
          SET estado = ?, insertadas = ?, actualizadas = ?, duplicadas = ?, rechazadas = ?,
              politica_duplicados = ?, decisiones = ?, confirmado_en = NOW(),
              mensaje = ?, resumen = JSON_MERGE_PATCH(COALESCE(resumen, '{}'), ?)
        WHERE id_historico = ?`,
      [
        estadoFinal,
        insertadas,
        actualizadas,
        omitidas,
        rechazadas,
        opciones.politicaDuplicados,
        JSON.stringify(opciones.decisiones),
        `Insertadas ${insertadas}, actualizadas ${actualizadas}, omitidas ${omitidas}, rechazadas ${rechazadas}.`,
        JSON.stringify({ pendientesTarifa, confirmadoPor: req.usuario!.email }),
        idHistorico,
      ],
    );

    eliminarLotePreparado(idHistorico);

    await auditarDesdeRequest(req, {
      accion: 'IMPORTACION_CONFIRMADA',
      entidad: 'historicos',
      idEntidad: idHistorico,
      despues: { insertadas, actualizadas, omitidas, rechazadas, pendientesTarifa, estadoFinal },
    });

    ok(res, {
      id_historico: idHistorico,
      estado: estadoFinal,
      insertadas,
      actualizadas,
      omitidas,
      rechazadas,
      pendientesTarifa,
      mensaje:
        `Importacion finalizada: ${insertadas} insertada(s), ${actualizadas} actualizada(s), ` +
        `${omitidas} omitida(s) por duplicidad y ${rechazadas} rechazada(s).` +
        (pendientesTarifa > 0
          ? ` ${pendientesTarifa} registro(s) quedaron PENDIENTES DE TARIFA: su energia se conserva pero aun no tienen valor en quetzales.`
          : ''),
    });
  }),
);

// ---------------------------------------------------------------------------
// Historial de importaciones
// ---------------------------------------------------------------------------
importacionesRouter.get(
  '/',
  requierePermiso(PERMISOS.IMPORTACIONES_VER),
  validarConsulta(
    esquemaPaginacion.extend({
      estado: z.string().max(30).optional(),
      id_proyecto: z.coerce.number().int().positive().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquemaPaginacion> & { estado?: string; id_proyecto?: number }>(req);
    const { limite, desplazamiento } = limitesPaginacion(p);
    const condiciones = ['1 = 1'];
    const params: unknown[] = [];

    if (p.estado) {
      condiciones.push('h.estado = ?');
      params.push(p.estado);
    }
    if (p.id_proyecto) {
      condiciones.push('h.id_proyecto = ?');
      params.push(p.id_proyecto);
    }
    if (p.buscar) {
      condiciones.push('h.nombre_archivo_original LIKE ?');
      params.push(`%${p.buscar}%`);
    }

    const donde = condiciones.join(' AND ');
    const filas = await query(
      `SELECT h.*, u.nombre AS usuario, pr.nombre AS proyecto
         FROM historicos h
         LEFT JOIN usuarios u ON u.id_usuario = h.id_usuario
         LEFT JOIN proyectos pr ON pr.id_proyecto = h.id_proyecto
        WHERE ${donde}
        ORDER BY h.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );
    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM historicos h WHERE ${donde}`,
      params,
    );
    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

importacionesRouter.get(
  '/:id',
  requierePermiso(PERMISOS.IMPORTACIONES_VER),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const historico = await queryOne(
      `SELECT h.*, u.nombre AS usuario, pr.nombre AS proyecto, i.marca, i.modelo
         FROM historicos h
         LEFT JOIN usuarios u ON u.id_usuario = h.id_usuario
         LEFT JOIN proyectos pr ON pr.id_proyecto = h.id_proyecto
         LEFT JOIN inversores i ON i.id_inversor = h.id_inversor
        WHERE h.id_historico = ?`,
      [id],
    );
    if (!historico) throw errores.noEncontrado('la importacion indicada');

    const errores_ = await query(
      'SELECT * FROM historico_errores WHERE id_historico = ? ORDER BY severidad, fila LIMIT 500',
      [id],
    );
    ok(res, { ...historico, errores: errores_ });
  }),
);

/** Descarga del detalle de errores en CSV. */
importacionesRouter.get(
  '/:id/errors',
  requierePermiso(PERMISOS.IMPORTACIONES_VER),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const filas = await query<{
      fila: number | null;
      columna: string | null;
      valor: string | null;
      codigo: string;
      severidad: string;
      mensaje: string;
    }>('SELECT fila, columna, valor, codigo, severidad, mensaje FROM historico_errores WHERE id_historico = ? ORDER BY fila', [id]);

    const escapar = (valor: unknown) => `"${String(valor ?? '').replace(/"/g, '""')}"`;
    const contenido = [
      'Fila,Columna,Valor,Codigo,Severidad,Mensaje',
      ...filas.map((f) =>
        [f.fila ?? '', f.columna ?? '', f.valor ?? '', f.codigo, f.severidad, f.mensaje]
          .map(escapar)
          .join(','),
      ),
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="errores_importacion_${id}.csv"`);
    res.send('﻿' + contenido);
  }),
);

/** Cancela una previsualizacion que aun no se confirmo. */
importacionesRouter.delete(
  '/:id',
  requierePermiso(PERMISOS.IMPORTACIONES_CARGAR),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const historico = await queryOne<{ estado: string }>(
      'SELECT estado FROM historicos WHERE id_historico = ?',
      [id],
    );
    if (!historico) throw errores.noEncontrado('la importacion indicada');
    if (historico.estado !== 'VALIDADO') {
      throw errores.reglaNegocio('Solo puede cancelarse una importacion que aun no fue confirmada.');
    }

    await execute("UPDATE historicos SET estado = 'RECHAZADO' WHERE id_historico = ?", [id]);
    eliminarLotePreparado(id);

    await auditarDesdeRequest(req, {
      accion: 'IMPORTACION_CANCELADA',
      entidad: 'historicos',
      idEntidad: id,
    });
    ok(res, { mensaje: 'Importacion cancelada. No se modifico ningun dato de produccion.' });
  }),
);
