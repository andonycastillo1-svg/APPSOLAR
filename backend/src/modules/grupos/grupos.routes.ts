import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../../db/pool';
import { errores } from '../../utils/errors';
import { asyncHandler, creado, ok, validarCuerpo } from '../../utils/http';
import { requierePermiso } from '../../middleware/autenticacion';
import { PERMISOS } from '../../config/permisos';
import { auditarDesdeRequest } from '../../services/auditoria';
import { hoyISO } from '../../utils/fechas';

/**
 * Grupos de inversores.
 *
 * Jerarquia del sistema:  PROYECTO  ->  GRUPO  ->  INVERSOR
 *
 * Un proyecto tiene varios grupos y cada grupo agrupa varios inversores.
 * El grupo declara cuantos inversores deberia tener y si cuenta con banco de
 * baterias, y es la unidad sobre la que se carga produccion manualmente
 * cuando la conexion con el fabricante falla.
 *
 * Tambien es la unidad donde se declaran los LOTES DE PANELES instalados
 * (cantidad + potencia unitaria en Wp): una instalacion con varios anios
 * suele tener paneles de distinta generacion en el mismo grupo (ej. una
 * ampliacion con paneles mas potentes). La cantidad de paneles y la
 * potencia instalada del grupo se calculan sumando sus lotes activos, y la
 * del proyecto sumando, a su vez, todos sus grupos -- nunca se captura por
 * separado a nivel de proyecto.
 *
 * Montado en `/api/projects/:projectId/groups` (requiere `mergeParams`).
 *
 * Permisos: se consulta con `proyectos.ver` y se gestiona con
 * `inversores.gestionar`, porque el grupo es una agrupacion de equipo y el
 * usuario operativo debe poder declararlo al registrar los inversores.
 */
export const gruposRouter = Router({ mergeParams: true });

const esquemaGrupo = z.object({
  nombre: z.string().trim().min(2, 'Indique el nombre del grupo.').max(120),
  cantidad_inversores_declarada: z.coerce
    .number()
    .int()
    .min(0, 'La cantidad de inversores no puede ser negativa.')
    .max(2000)
    .optional()
    .nullable(),
  tiene_banco_baterias: z.boolean().default(false),
  capacidad_baterias_kwh: z.coerce
    .number()
    .min(0, 'La capacidad del banco no puede ser negativa.')
    .optional()
    .nullable(),
  capacidad_kwp: z.coerce
    .number()
    .min(0, 'La potencia instalada no puede ser negativa.')
    .optional()
    .nullable(),
  ubicacion: z.string().trim().max(255).optional().nullable(),
  observaciones: z.string().trim().max(500).optional().nullable(),
  activo: z.boolean().default(true),
});

/**
 * Lote de paneles de un grupo: una cantidad de paneles con la misma
 * potencia unitaria (Wp). Existen para representar instalaciones con
 * generaciones de paneles distintas dentro de un mismo grupo -- por
 * ejemplo, paneles originales de 440 Wp mas una ampliacion posterior con
 * paneles de 640 Wp. La cantidad total de paneles y la potencia instalada
 * en kWp de un grupo (y de un proyecto) se OBTIENEN SUMANDO sus lotes
 * activos; no se guardan como columna redundante.
 */
const esquemaLotePaneles = z.object({
  cantidad: z.coerce
    .number()
    .int()
    .positive('Indique cuantos paneles tiene este lote.')
    .max(100000),
  potencia_wp: z.coerce
    .number()
    .positive('Indique la potencia de cada panel en vatios (Wp).')
    .max(10000),
  marca: z.string().trim().max(80).optional().nullable(),
  modelo: z.string().trim().max(120).optional().nullable(),
  fecha_instalacion: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.')
    .optional()
    .nullable(),
  observaciones: z.string().trim().max(500).optional().nullable(),
  activo: z.boolean().default(true),
});

/**
 * Subconsulta reutilizable: totales de paneles activos de un grupo.
 *
 * Si algun inversor activo del grupo tiene sus paneles registrados, el total
 * sale de la suma de los inversores; de lo contrario, de los lotes del grupo.
 * Nunca se suman ambos (evita contar dos veces los mismos paneles).
 */
export const SUBCONSULTA_PANELES = `
  IF(EXISTS (SELECT 1 FROM inversores iv WHERE iv.id_grupo = g.id_grupo AND iv.activo = 1
                AND iv.cantidad_paneles IS NOT NULL),
     (SELECT COALESCE(SUM(iv.cantidad_paneles), 0) FROM inversores iv
       WHERE iv.id_grupo = g.id_grupo AND iv.activo = 1),
     (SELECT COALESCE(SUM(pl.cantidad), 0) FROM paneles_grupo pl
       WHERE pl.id_grupo = g.id_grupo AND pl.activo = 1)) AS cantidad_paneles,
  IF(EXISTS (SELECT 1 FROM inversores iv WHERE iv.id_grupo = g.id_grupo AND iv.activo = 1
                AND iv.cantidad_paneles IS NOT NULL),
     (SELECT COALESCE(SUM(iv.cantidad_paneles * iv.potencia_panel_wp), 0) / 1000 FROM inversores iv
       WHERE iv.id_grupo = g.id_grupo AND iv.activo = 1),
     (SELECT COALESCE(SUM(pl.cantidad * pl.potencia_wp), 0) / 1000 FROM paneles_grupo pl
       WHERE pl.id_grupo = g.id_grupo AND pl.activo = 1)) AS capacidad_paneles_kwp,
  IF(EXISTS (SELECT 1 FROM inversores iv WHERE iv.id_grupo = g.id_grupo AND iv.activo = 1
                AND iv.cantidad_paneles IS NOT NULL), 'INVERSORES', 'LOTES') AS origen_paneles`;

async function proyectoDe(req: { params: Record<string, string> }): Promise<number> {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id <= 0) throw errores.solicitudInvalida('Proyecto invalido.');
  const existe = await queryOne('SELECT id_proyecto FROM proyectos WHERE id_proyecto = ?', [id]);
  if (!existe) throw errores.noEncontrado('el proyecto indicado');
  return id;
}

/** Confirma que el grupo exista y pertenezca al proyecto de la ruta. */
async function grupoDe(idProyecto: number, req: { params: Record<string, string> }): Promise<number> {
  const id = Number(req.params.groupId);
  if (!Number.isInteger(id) || id <= 0) throw errores.solicitudInvalida('Grupo invalido.');
  const existe = await queryOne('SELECT id_grupo FROM grupos WHERE id_grupo = ? AND id_proyecto = ?', [
    id,
    idProyecto,
  ]);
  if (!existe) throw errores.noEncontrado('el grupo indicado');
  return id;
}

/** Coherencia entre el indicador de baterias y su capacidad declarada. */
function validarBaterias(datos: Partial<z.infer<typeof esquemaGrupo>>): void {
  if (!datos.tiene_banco_baterias && datos.capacidad_baterias_kwh) {
    throw errores.validacion(
      'Se indico una capacidad de banco de baterias en un grupo marcado como SIN banco. ' +
        'Active el indicador o deje la capacidad vacia.',
    );
  }
}

// ---------------------------------------------------------------------------
// GET /projects/:projectId/groups
// ---------------------------------------------------------------------------
gruposRouter.get(
  '/',
  requierePermiso(PERMISOS.PROYECTOS_VER),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);

    const grupos = await query<{
      id_grupo: number;
      nombre: string;
      cantidad_inversores_declarada: number | null;
      inversores_registrados: number;
      tiene_banco_baterias: number;
      capacidad_baterias_kwh: number | null;
      capacidad_kwp: number | null;
      cantidad_paneles: number;
      capacidad_paneles_kwp: number;
      ubicacion: string | null;
      observaciones: string | null;
      activo: number;
      kwh_total: number;
      ultima_produccion: string | null;
    }>(
      `SELECT g.*,
              (SELECT COUNT(*) FROM inversores i
                WHERE i.id_grupo = g.id_grupo AND i.activo = 1) AS inversores_registrados,
              (SELECT COALESCE(SUM(p.kwh), 0) FROM produccion p
                WHERE p.id_grupo = g.id_grupo AND p.activo = 1) AS kwh_total,
              (SELECT MAX(p.fecha) FROM produccion p
                WHERE p.id_grupo = g.id_grupo AND p.activo = 1) AS ultima_produccion,
              ${SUBCONSULTA_PANELES}
         FROM grupos g
        WHERE g.id_proyecto = ?
        ORDER BY g.nombre`,
      [idProyecto],
    );

    const conAvisos = grupos.map((grupo) => {
      const declarados = grupo.cantidad_inversores_declarada;
      const registrados = Number(grupo.inversores_registrados);
      return {
        ...grupo,
        inversores_registrados: registrados,
        // Aviso operativo: faltan equipos por registrar respecto de lo declarado.
        inversoresFaltantes:
          declarados !== null && declarados > registrados ? declarados - registrados : 0,
        avisoInversores:
          declarados !== null && declarados !== registrados
            ? `El grupo declara ${declarados} inversor(es) y tiene ${registrados} registrado(s).`
            : null,
      };
    });

    ok(res, conAvisos, {
      totales: {
        grupos: conAvisos.length,
        inversoresRegistrados: conAvisos.reduce((a, g) => a + g.inversores_registrados, 0),
        inversoresDeclarados: conAvisos.reduce(
          (a, g) => a + (g.cantidad_inversores_declarada ?? 0),
          0,
        ),
        gruposConBaterias: conAvisos.filter((g) => g.tiene_banco_baterias).length,
        capacidadBateriasKwh: conAvisos.reduce(
          (a, g) => a + Number(g.capacidad_baterias_kwh ?? 0),
          0,
        ),
        // El total de paneles del PROYECTO nunca se captura por separado:
        // siempre es la suma de los lotes de todos sus grupos.
        cantidadPaneles: conAvisos.reduce((a, g) => a + Number(g.cantidad_paneles ?? 0), 0),
        capacidadPanelesKwp: conAvisos.reduce(
          (a, g) => a + Number(g.capacidad_paneles_kwp ?? 0),
          0,
        ),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /projects/:projectId/groups/:groupId
// ---------------------------------------------------------------------------
gruposRouter.get(
  '/:groupId',
  requierePermiso(PERMISOS.PROYECTOS_VER),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idGrupo = Number(req.params.groupId);

    const grupo = await queryOne(
      `SELECT g.*, ${SUBCONSULTA_PANELES}
         FROM grupos g WHERE g.id_grupo = ? AND g.id_proyecto = ?`,
      [idGrupo, idProyecto],
    );
    if (!grupo) throw errores.noEncontrado('el grupo indicado');

    const inversores = await query(
      `SELECT i.*, (SELECT MAX(p.fecha) FROM produccion p
                     WHERE p.id_inversor = i.id_inversor AND p.activo = 1) AS ultima_produccion
         FROM inversores i WHERE i.id_grupo = ? ORDER BY i.marca, i.modelo`,
      [idGrupo],
    );

    const paneles = await query(
      `SELECT * FROM paneles_grupo WHERE id_grupo = ? AND activo = 1
        ORDER BY fecha_instalacion IS NULL, fecha_instalacion, id_lote`,
      [idGrupo],
    );

    const produccionMensual = await query(
      `SELECT anio, mes, COALESCE(SUM(kwh), 0) AS kwh, COALESCE(SUM(valor_q), 0) AS valor_q,
              GROUP_CONCAT(DISTINCT nivel_detalle) AS niveles,
              SUM(estado_valorizacion = 'PENDIENTE_DE_TARIFA') AS pendientes
         FROM produccion WHERE id_grupo = ? AND activo = 1
        GROUP BY anio, mes ORDER BY anio DESC, mes DESC LIMIT 24`,
      [idGrupo],
    );

    ok(res, { ...grupo, inversores, paneles, produccionMensual });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/groups
// ---------------------------------------------------------------------------
gruposRouter.post(
  '/',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  validarCuerpo(esquemaGrupo),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const datos = req.body as z.infer<typeof esquemaGrupo>;
    validarBaterias(datos);

    const duplicado = await queryOne(
      'SELECT id_grupo FROM grupos WHERE id_proyecto = ? AND nombre = ?',
      [idProyecto, datos.nombre],
    );
    if (duplicado) {
      throw errores.conflicto('Ya existe un grupo con ese nombre en este proyecto.');
    }

    const resultado = await execute(
      `INSERT INTO grupos
         (id_proyecto, nombre, cantidad_inversores_declarada, tiene_banco_baterias,
          capacidad_baterias_kwh, capacidad_kwp, ubicacion, observaciones, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        idProyecto,
        datos.nombre,
        datos.cantidad_inversores_declarada ?? null,
        datos.tiene_banco_baterias ? 1 : 0,
        datos.tiene_banco_baterias ? (datos.capacidad_baterias_kwh ?? null) : null,
        datos.capacidad_kwp ?? null,
        datos.ubicacion || null,
        datos.observaciones || null,
        datos.activo ? 1 : 0,
        req.usuario!.id_usuario,
      ],
    );

    await auditarDesdeRequest(req, {
      accion: 'GRUPO_CREADO',
      entidad: 'grupos',
      idEntidad: resultado.insertId,
      despues: { ...datos, id_proyecto: idProyecto },
    });

    creado(res, {
      id_grupo: resultado.insertId,
      mensaje: 'Grupo creado correctamente. Ya puede registrar sus inversores.',
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /projects/:projectId/groups/:groupId
// ---------------------------------------------------------------------------
gruposRouter.put(
  '/:groupId',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  validarCuerpo(esquemaGrupo.partial()),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idGrupo = Number(req.params.groupId);
    const datos = req.body as Partial<z.infer<typeof esquemaGrupo>>;

    const actual = await queryOne<{ tiene_banco_baterias: number }>(
      'SELECT * FROM grupos WHERE id_grupo = ? AND id_proyecto = ?',
      [idGrupo, idProyecto],
    );
    if (!actual) throw errores.noEncontrado('el grupo indicado');

    validarBaterias({
      tiene_banco_baterias: datos.tiene_banco_baterias ?? Boolean(actual.tiene_banco_baterias),
      capacidad_baterias_kwh: datos.capacidad_baterias_kwh,
    });

    if (datos.nombre) {
      const duplicado = await queryOne(
        'SELECT id_grupo FROM grupos WHERE id_proyecto = ? AND nombre = ? AND id_grupo <> ?',
        [idProyecto, datos.nombre, idGrupo],
      );
      if (duplicado) throw errores.conflicto('Ya existe otro grupo con ese nombre en el proyecto.');
    }

    const mapa: Record<string, unknown> = {
      nombre: datos.nombre,
      cantidad_inversores_declarada: datos.cantidad_inversores_declarada,
      tiene_banco_baterias:
        datos.tiene_banco_baterias === undefined ? undefined : datos.tiene_banco_baterias ? 1 : 0,
      capacidad_baterias_kwh:
        datos.tiene_banco_baterias === false ? null : datos.capacidad_baterias_kwh,
      capacidad_kwp: datos.capacidad_kwp,
      ubicacion: datos.ubicacion,
      observaciones: datos.observaciones,
      activo: datos.activo === undefined ? undefined : datos.activo ? 1 : 0,
    };
    const campos = Object.entries(mapa).filter(([, v]) => v !== undefined);
    if (campos.length === 0) throw errores.solicitudInvalida('No se enviaron cambios.');

    await execute(
      `UPDATE grupos SET ${campos.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ?
        WHERE id_grupo = ?`,
      [...campos.map(([, v]) => v), req.usuario!.id_usuario, idGrupo],
    );

    await auditarDesdeRequest(req, {
      accion: 'GRUPO_ACTUALIZADO',
      entidad: 'grupos',
      idEntidad: idGrupo,
      antes: actual,
      despues: datos,
    });

    ok(res, { mensaje: 'Grupo actualizado correctamente.' });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /projects/:projectId/groups/:groupId
// ---------------------------------------------------------------------------
gruposRouter.delete(
  '/:groupId',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idGrupo = Number(req.params.groupId);

    const grupo = await queryOne('SELECT * FROM grupos WHERE id_grupo = ? AND id_proyecto = ?', [
      idGrupo,
      idProyecto,
    ]);
    if (!grupo) throw errores.noEncontrado('el grupo indicado');

    const relaciones = await queryOne<{ inversores: number; produccion: number }>(
      `SELECT (SELECT COUNT(*) FROM inversores WHERE id_grupo = ?) AS inversores,
              (SELECT COUNT(*) FROM produccion WHERE id_grupo = ?) AS produccion`,
      [idGrupo, idGrupo],
    );

    if ((relaciones?.inversores ?? 0) > 0 || (relaciones?.produccion ?? 0) > 0) {
      await execute('UPDATE grupos SET activo = 0, updated_by = ? WHERE id_grupo = ?', [
        req.usuario!.id_usuario,
        idGrupo,
      ]);
      await auditarDesdeRequest(req, {
        accion: 'GRUPO_DESACTIVADO',
        entidad: 'grupos',
        idEntidad: idGrupo,
        antes: grupo,
        motivo: 'Tiene inversores o produccion asociada',
      });
      ok(res, {
        eliminado: false,
        mensaje:
          `El grupo tiene ${relaciones?.inversores} inversor(es) y ${relaciones?.produccion} ` +
          'registro(s) de produccion, por lo que fue desactivado para conservar el historico.',
      });
      return;
    }

    await execute('DELETE FROM grupos WHERE id_grupo = ?', [idGrupo]);
    await auditarDesdeRequest(req, {
      accion: 'GRUPO_ELIMINADO',
      entidad: 'grupos',
      idEntidad: idGrupo,
      antes: grupo,
    });
    ok(res, { eliminado: true, mensaje: 'Grupo eliminado correctamente.' });
  }),
);

// ---------------------------------------------------------------------------
// Lotes de paneles del grupo
//
// Cada lote representa una cantidad de paneles con la misma potencia
// unitaria. Un grupo puede tener varios lotes (instalacion original mas
// ampliaciones posteriores con paneles de otra generacion). El total de
// paneles y la potencia instalada en kWp se calculan SUMANDO los lotes
// activos, tanto a nivel de grupo como -- sumando todos sus grupos -- a
// nivel de proyecto (ver GET /projects/:projectId/groups y GET /projects/:id).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /projects/:projectId/groups/:groupId/panels
// ---------------------------------------------------------------------------
gruposRouter.get(
  '/:groupId/panels',
  requierePermiso(PERMISOS.PROYECTOS_VER),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idGrupo = await grupoDe(idProyecto, req);

    const lotes = await query(
      `SELECT * FROM paneles_grupo WHERE id_grupo = ? AND activo = 1
        ORDER BY fecha_instalacion IS NULL, fecha_instalacion, id_lote`,
      [idGrupo],
    );

    ok(res, lotes, {
      totales: {
        lotes: lotes.length,
        cantidadPaneles: lotes.reduce((a, l) => a + Number(l.cantidad), 0),
        capacidadKwp: lotes.reduce((a, l) => a + (Number(l.cantidad) * Number(l.potencia_wp)) / 1000, 0),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /projects/:projectId/groups/:groupId/panels
// ---------------------------------------------------------------------------
gruposRouter.post(
  '/:groupId/panels',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  validarCuerpo(esquemaLotePaneles),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idGrupo = await grupoDe(idProyecto, req);
    const datos = req.body as z.infer<typeof esquemaLotePaneles>;

    if (datos.fecha_instalacion && datos.fecha_instalacion > hoyISO()) {
      throw errores.validacion('La fecha de instalacion no puede ser futura.');
    }

    const resultado = await execute(
      `INSERT INTO paneles_grupo
         (id_grupo, cantidad, potencia_wp, marca, modelo, fecha_instalacion,
          observaciones, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        idGrupo,
        datos.cantidad,
        datos.potencia_wp,
        datos.marca || null,
        datos.modelo || null,
        datos.fecha_instalacion || null,
        datos.observaciones || null,
        datos.activo ? 1 : 0,
        req.usuario!.id_usuario,
      ],
    );

    await auditarDesdeRequest(req, {
      accion: 'LOTE_PANELES_CREADO',
      entidad: 'paneles_grupo',
      idEntidad: resultado.insertId,
      despues: { ...datos, id_grupo: idGrupo },
    });

    creado(res, {
      id_lote: resultado.insertId,
      capacidad_kwp: (datos.cantidad * datos.potencia_wp) / 1000,
      mensaje: `Lote de ${datos.cantidad} panel(es) de ${datos.potencia_wp} Wp registrado correctamente.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /projects/:projectId/groups/:groupId/panels/:panelId
// ---------------------------------------------------------------------------
gruposRouter.put(
  '/:groupId/panels/:panelId',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  validarCuerpo(esquemaLotePaneles.partial()),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idGrupo = await grupoDe(idProyecto, req);
    const idLote = Number(req.params.panelId);
    const datos = req.body as Partial<z.infer<typeof esquemaLotePaneles>>;

    const actual = await queryOne(
      'SELECT * FROM paneles_grupo WHERE id_lote = ? AND id_grupo = ?',
      [idLote, idGrupo],
    );
    if (!actual) throw errores.noEncontrado('el lote de paneles indicado');

    if (datos.fecha_instalacion && datos.fecha_instalacion > hoyISO()) {
      throw errores.validacion('La fecha de instalacion no puede ser futura.');
    }

    const mapa: Record<string, unknown> = {
      cantidad: datos.cantidad,
      potencia_wp: datos.potencia_wp,
      marca: datos.marca,
      modelo: datos.modelo,
      fecha_instalacion: datos.fecha_instalacion,
      observaciones: datos.observaciones,
      activo: datos.activo === undefined ? undefined : datos.activo ? 1 : 0,
    };
    const campos = Object.entries(mapa).filter(([, v]) => v !== undefined);
    if (campos.length === 0) throw errores.solicitudInvalida('No se enviaron cambios.');

    await execute(
      `UPDATE paneles_grupo SET ${campos.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ?
        WHERE id_lote = ?`,
      [...campos.map(([, v]) => v), req.usuario!.id_usuario, idLote],
    );

    await auditarDesdeRequest(req, {
      accion: 'LOTE_PANELES_ACTUALIZADO',
      entidad: 'paneles_grupo',
      idEntidad: idLote,
      antes: actual,
      despues: datos,
    });

    ok(res, { mensaje: 'Lote de paneles actualizado correctamente.' });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /projects/:projectId/groups/:groupId/panels/:panelId
//
// Siempre desactiva (nunca borra fisicamente): un lote retirado sigue
// siendo parte del historico de la instalacion (ej. paneles reemplazados).
// ---------------------------------------------------------------------------
gruposRouter.delete(
  '/:groupId/panels/:panelId',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  asyncHandler(async (req, res) => {
    const idProyecto = await proyectoDe(req);
    const idGrupo = await grupoDe(idProyecto, req);
    const idLote = Number(req.params.panelId);

    const actual = await queryOne(
      'SELECT * FROM paneles_grupo WHERE id_lote = ? AND id_grupo = ?',
      [idLote, idGrupo],
    );
    if (!actual) throw errores.noEncontrado('el lote de paneles indicado');

    await execute('UPDATE paneles_grupo SET activo = 0, updated_by = ? WHERE id_lote = ?', [
      req.usuario!.id_usuario,
      idLote,
    ]);

    await auditarDesdeRequest(req, {
      accion: 'LOTE_PANELES_DESACTIVADO',
      entidad: 'paneles_grupo',
      idEntidad: idLote,
      antes: actual,
    });

    ok(res, { mensaje: 'Lote de paneles retirado del total activo del grupo.' });
  }),
);
