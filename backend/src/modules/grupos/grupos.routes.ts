import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../../db/pool';
import { errores } from '../../utils/errors';
import { asyncHandler, creado, ok, validarCuerpo } from '../../utils/http';
import { requierePermiso } from '../../middleware/autenticacion';
import { PERMISOS } from '../../config/permisos';
import { auditarDesdeRequest } from '../../services/auditoria';

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

async function proyectoDe(req: { params: Record<string, string> }): Promise<number> {
  const id = Number(req.params.projectId);
  if (!Number.isInteger(id) || id <= 0) throw errores.solicitudInvalida('Proyecto invalido.');
  const existe = await queryOne('SELECT id_proyecto FROM proyectos WHERE id_proyecto = ?', [id]);
  if (!existe) throw errores.noEncontrado('el proyecto indicado');
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
                WHERE p.id_grupo = g.id_grupo AND p.activo = 1) AS ultima_produccion
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
      'SELECT * FROM grupos WHERE id_grupo = ? AND id_proyecto = ?',
      [idGrupo, idProyecto],
    );
    if (!grupo) throw errores.noEncontrado('el grupo indicado');

    const inversores = await query(
      `SELECT i.*, (SELECT MAX(p.fecha) FROM produccion p
                     WHERE p.id_inversor = i.id_inversor AND p.activo = 1) AS ultima_produccion
         FROM inversores i WHERE i.id_grupo = ? ORDER BY i.marca, i.modelo`,
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

    ok(res, { ...grupo, inversores, produccionMensual });
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
