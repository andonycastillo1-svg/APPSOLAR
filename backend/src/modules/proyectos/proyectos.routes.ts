import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction } from '../../db/pool';
import { errores } from '../../utils/errors';
import {
  asyncHandler,
  columnaOrden,
  consulta,
  creado,
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
import { tarifasRouter } from '../tarifas/tarifas.routes';
import { proyeccionesRouter } from '../proyecciones/proyecciones.routes';
import { gruposRouter } from '../grupos/grupos.routes';

export const proyectosRouter = Router();
proyectosRouter.use(requiereAutenticacion);

const TIPOS = ['PPA', 'EPC', 'AUTOCONSUMO', 'OTRO'] as const;

const esquemaProyecto = z.object({
  id_cliente: z.coerce.number().int().positive('Seleccione el cliente propietario del proyecto.'),
  nombre: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres.').max(160),
  ubicacion: z.string().trim().max(255).optional().nullable(),
  tipo_proyecto: z.enum(TIPOS).default('OTRO'),
  capacidad_kwp: z.coerce.number().min(0, 'La potencia instalada no puede ser negativa.').optional().nullable(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato aaaa-mm-dd.').optional().nullable(),
  observaciones: z.string().trim().max(500).optional().nullable(),
  activo: z.boolean().default(true),
});

/**
 * Alta de proyecto.
 *
 * La proyeccion anual repartida mensualmente es OBLIGATORIA: es la base
 * contra la que se mide el cumplimiento durante toda la vida del proyecto,
 * de modo que un proyecto no puede existir sin ella.
 *
 * Los grupos de inversores pueden declararse en el mismo acto: un proyecto
 * lleva varios grupos y cada grupo varios inversores.
 */
const esquemaMesProyeccion = z.object({
  mes: z.coerce.number().int().min(1).max(12),
  proyeccion_kwh: z.coerce.number().min(0, 'La proyeccion no puede ser negativa.'),
});

const esquemaGrupoInicial = z.object({
  nombre: z.string().trim().min(2).max(120),
  cantidad_inversores_declarada: z.coerce.number().int().min(0).max(2000).optional().nullable(),
  tiene_banco_baterias: z.boolean().default(false),
  capacidad_baterias_kwh: z.coerce.number().min(0).optional().nullable(),
  capacidad_kwp: z.coerce.number().min(0).optional().nullable(),
  ubicacion: z.string().trim().max(255).optional().nullable(),
});

const esquemaAlta = esquemaProyecto.extend({
  proyeccion: z.object({
    anio: z.coerce.number().int().min(2000).max(2100),
    meses: z
      .array(esquemaMesProyeccion)
      .length(12, 'Debe capturar los 12 meses de la proyeccion anual.'),
    aprobarInmediato: z.boolean().default(true),
  }),
  grupos: z.array(esquemaGrupoInicial).max(50).optional(),
});

const COLUMNAS = {
  nombre: 'pr.nombre',
  cliente: 'c.nombre',
  tipo: 'pr.tipo_proyecto',
  creado: 'pr.created_at',
};

// Submodulos anidados: tarifas y proyecciones pertenecen al proyecto.
proyectosRouter.use('/:projectId/groups', gruposRouter);
proyectosRouter.use('/:projectId/rates', tarifasRouter);
proyectosRouter.use('/:projectId/projections', proyeccionesRouter);

proyectosRouter.get(
  '/',
  requierePermiso(PERMISOS.PROYECTOS_VER),
  validarConsulta(
    esquemaPaginacion.extend({
      id_cliente: z.coerce.number().int().positive().optional(),
      tipo_proyecto: z.enum(TIPOS).optional(),
      activo: z.enum(['1', '0']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<
      z.infer<typeof esquemaPaginacion> & {
        id_cliente?: number;
        tipo_proyecto?: string;
        activo?: string;
      }
    >(req);
    const { limite, desplazamiento } = limitesPaginacion(p);
    const condiciones = ['1 = 1'];
    const params: unknown[] = [];

    if (p.buscar) {
      condiciones.push('(pr.nombre LIKE ? OR pr.ubicacion LIKE ? OR c.nombre LIKE ?)');
      params.push(`%${p.buscar}%`, `%${p.buscar}%`, `%${p.buscar}%`);
    }
    if (p.id_cliente) {
      condiciones.push('pr.id_cliente = ?');
      params.push(p.id_cliente);
    }
    if (p.tipo_proyecto) {
      condiciones.push('pr.tipo_proyecto = ?');
      params.push(p.tipo_proyecto);
    }
    if (p.activo !== undefined) {
      condiciones.push('pr.activo = ?');
      params.push(Number(p.activo));
    }

    const donde = condiciones.join(' AND ');

    /**
     * La produccion acumulada y su valor se calculan SIN mezclar niveles de
     * detalle: se suma el consolidado de proyecto y el detalle por inversor por
     * separado, y se prioriza el detalle cuando ambos existen para el periodo.
     * Aqui se reporta el total general marcando si hay mezcla de niveles.
     */
    const filas = await query(
      `SELECT pr.*, c.nombre AS cliente, c.nit AS cliente_nit,
              (SELECT COUNT(*) FROM inversores i WHERE i.id_proyecto = pr.id_proyecto AND i.activo = 1) AS inversores,
              (SELECT COALESCE(SUM(p.kwh), 0) FROM produccion p
                WHERE p.id_proyecto = pr.id_proyecto AND p.activo = 1
                  AND p.nivel_detalle = 'POR_INVERSOR') AS kwh_por_inversor,
              (SELECT COALESCE(SUM(p.kwh), 0) FROM produccion p
                WHERE p.id_proyecto = pr.id_proyecto AND p.activo = 1
                  AND p.nivel_detalle = 'PROYECTO_CONSOLIDADO') AS kwh_consolidado,
              (SELECT COALESCE(SUM(p.valor_q), 0) FROM produccion p
                WHERE p.id_proyecto = pr.id_proyecto AND p.activo = 1) AS valor_q_total,
              (SELECT COUNT(*) FROM produccion p
                WHERE p.id_proyecto = pr.id_proyecto AND p.activo = 1
                  AND p.estado_valorizacion = 'PENDIENTE_DE_TARIFA') AS registros_pendientes,
              (SELECT MAX(p.fecha) FROM produccion p
                WHERE p.id_proyecto = pr.id_proyecto AND p.activo = 1) AS ultima_produccion
         FROM proyectos pr JOIN clientes c ON c.id_cliente = pr.id_cliente
        WHERE ${donde}
        ORDER BY ${columnaOrden(p.orden, COLUMNAS, 'pr.nombre')} ${p.direccion === 'desc' ? 'DESC' : 'ASC'}
        LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );

    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM proyectos pr JOIN clientes c ON c.id_cliente = pr.id_cliente WHERE ${donde}`,
      params,
    );

    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

proyectosRouter.get(
  '/:id',
  requierePermiso(PERMISOS.PROYECTOS_VER),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const proyecto = await queryOne(
      `SELECT pr.*, c.nombre AS cliente, c.nit AS cliente_nit
         FROM proyectos pr JOIN clientes c ON c.id_cliente = pr.id_cliente
        WHERE pr.id_proyecto = ?`,
      [id],
    );
    if (!proyecto) throw errores.noEncontrado('el proyecto solicitado');

    const grupos = await query(
      `SELECT g.*,
              (SELECT COUNT(*) FROM inversores i
                WHERE i.id_grupo = g.id_grupo AND i.activo = 1) AS inversores_registrados,
              (SELECT COALESCE(SUM(p.kwh), 0) FROM produccion p
                WHERE p.id_grupo = g.id_grupo AND p.activo = 1) AS kwh_total
         FROM grupos g WHERE g.id_proyecto = ? ORDER BY g.nombre`,
      [id],
    );

    const inversores = await query(
      `SELECT i.*, g.nombre AS grupo,
              (SELECT MAX(p.fecha) FROM produccion p WHERE p.id_inversor = i.id_inversor AND p.activo = 1) AS ultima_produccion
         FROM inversores i JOIN grupos g ON g.id_grupo = i.id_grupo
        WHERE i.id_proyecto = ? ORDER BY g.nombre, i.marca, i.modelo`,
      [id],
    );

    const resumen = await queryOne(
      `SELECT COALESCE(SUM(kwh), 0) AS kwh_total,
              COALESCE(SUM(valor_q), 0) AS valor_total,
              SUM(estado_valorizacion = 'PENDIENTE_DE_TARIFA') AS registros_pendientes,
              MIN(fecha) AS primera_fecha, MAX(fecha) AS ultima_fecha
         FROM produccion WHERE id_proyecto = ? AND activo = 1`,
      [id],
    );

    const tarifas = await query(
      `SELECT anio, trimestre, costo_kwh, estado FROM tarifas_kwh
        WHERE id_proyecto = ? AND estado <> 'ANULADA'
        ORDER BY anio DESC, trimestre DESC LIMIT 12`,
      [id],
    );

    const proyeccion = await queryOne(
      `SELECT anio, COUNT(*) AS meses, COALESCE(SUM(proyeccion_kwh), 0) AS total_kwh
         FROM proyecciones_kwh
        WHERE id_proyecto = ? AND estado = 'APROBADA'
        GROUP BY anio ORDER BY anio DESC LIMIT 1`,
      [id],
    );

    ok(res, {
      ...proyecto,
      grupos,
      inversores,
      resumen,
      tarifasRecientes: tarifas,
      proyeccionVigente: proyeccion,
    });
  }),
);

proyectosRouter.post(
  '/',
  requierePermiso(PERMISOS.PROYECTOS_GESTIONAR),
  validarCuerpo(esquemaAlta),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaAlta>;

    // Regla de negocio: no se puede crear un proyecto sin cliente existente.
    const cliente = await queryOne<{ activo: number }>(
      'SELECT activo FROM clientes WHERE id_cliente = ?',
      [datos.id_cliente],
    );
    if (!cliente) throw errores.validacion('El cliente indicado no existe.');
    if (!cliente.activo) {
      throw errores.reglaNegocio('No es posible crear proyectos para un cliente desactivado.');
    }

    const duplicado = await queryOne('SELECT id_proyecto FROM proyectos WHERE nombre = ?', [
      datos.nombre,
    ]);
    if (duplicado) {
      throw errores.conflicto(
        'Ya existe un proyecto con ese nombre. Los nombres deben ser unicos porque el formato historico identifica la planta por su nombre.',
      );
    }

    // La proyeccion debe cubrir los 12 meses sin repetirlos.
    const mesesCapturados = new Set(datos.proyeccion.meses.map((m) => m.mes));
    if (mesesCapturados.size !== 12) {
      throw errores.validacion(
        'La proyeccion anual debe incluir los 12 meses exactamente una vez.',
        { mesesRecibidos: [...mesesCapturados].sort((a, b) => a - b) },
      );
    }

    const totalProyectado = datos.proyeccion.meses.reduce((a, m) => a + m.proyeccion_kwh, 0);
    if (totalProyectado <= 0) {
      throw errores.validacion(
        'La proyeccion anual no puede ser cero: es la base de comparacion del cumplimiento.',
      );
    }

    const nombresGrupo = (datos.grupos ?? []).map((g) => g.nombre);
    if (new Set(nombresGrupo).size !== nombresGrupo.length) {
      throw errores.validacion('Los nombres de los grupos deben ser distintos entre si.');
    }

    // El proyecto, su proyeccion anual y sus grupos se crean en una sola
    // transaccion: o queda todo consistente o no queda nada.
    const resultado = await withTransaction(async (conn) => {
      const proyecto = await execute(
        `INSERT INTO proyectos
           (id_cliente, nombre, ubicacion, tipo_proyecto, capacidad_kwp, fecha_inicio,
            observaciones, activo, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          datos.id_cliente,
          datos.nombre,
          datos.ubicacion || null,
          datos.tipo_proyecto,
          datos.capacidad_kwp ?? null,
          datos.fecha_inicio || null,
          datos.observaciones || null,
          datos.activo ? 1 : 0,
          req.usuario!.id_usuario,
        ],
        conn,
      );
      const idProyecto = proyecto.insertId;

      const apruebaProyeccion =
        datos.proyeccion.aprobarInmediato &&
        req.usuario!.permisos.includes(PERMISOS.PROYECCIONES_APROBAR);

      for (const mes of datos.proyeccion.meses) {
        await execute(
          `INSERT INTO proyecciones_kwh
             (id_proyecto, anio, mes, proyeccion_kwh, estado, origen, comentarios,
              creado_por, aprobado_por, fecha_aprobacion)
           VALUES (?, ?, ?, ?, ?, 'MANUAL', 'Capturada en el alta del proyecto', ?, ?, ?)`,
          [
            idProyecto,
            datos.proyeccion.anio,
            mes.mes,
            mes.proyeccion_kwh,
            apruebaProyeccion ? 'APROBADA' : 'BORRADOR',
            req.usuario!.id_usuario,
            apruebaProyeccion ? req.usuario!.id_usuario : null,
            apruebaProyeccion ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
          ],
          conn,
        );
      }

      const idsGrupo: number[] = [];
      for (const grupo of datos.grupos ?? []) {
        const creadoGrupo = await execute(
          `INSERT INTO grupos
             (id_proyecto, nombre, cantidad_inversores_declarada, tiene_banco_baterias,
              capacidad_baterias_kwh, capacidad_kwp, ubicacion, activo, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [
            idProyecto,
            grupo.nombre,
            grupo.cantidad_inversores_declarada ?? null,
            grupo.tiene_banco_baterias ? 1 : 0,
            grupo.tiene_banco_baterias ? (grupo.capacidad_baterias_kwh ?? null) : null,
            grupo.capacidad_kwp ?? null,
            grupo.ubicacion || null,
            req.usuario!.id_usuario,
          ],
          conn,
        );
        idsGrupo.push(creadoGrupo.insertId);
      }

      return { idProyecto, idsGrupo, apruebaProyeccion };
    });

    await auditarDesdeRequest(req, {
      accion: 'PROYECTO_CREADO',
      entidad: 'proyectos',
      idEntidad: resultado.idProyecto,
      despues: {
        ...datos,
        proyeccion: {
          anio: datos.proyeccion.anio,
          total_kwh: totalProyectado,
          estado: resultado.apruebaProyeccion ? 'APROBADA' : 'BORRADOR',
        },
        grupos: nombresGrupo,
      },
    });

    creado(res, {
      id_proyecto: resultado.idProyecto,
      grupos: resultado.idsGrupo,
      proyeccion: {
        anio: datos.proyeccion.anio,
        meses: datos.proyeccion.meses.length,
        total_kwh: totalProyectado,
        estado: resultado.apruebaProyeccion ? 'APROBADA' : 'BORRADOR',
      },
      mensaje:
        `Proyecto creado con su proyeccion anual de ${totalProyectado.toLocaleString('es-GT')} kWh` +
        (resultado.idsGrupo.length > 0 ? ` y ${resultado.idsGrupo.length} grupo(s).` : '.') +
        (resultado.apruebaProyeccion ? '' : ' La proyeccion quedo en BORRADOR: debe aprobarse.'),
    });
  }),
);

proyectosRouter.put(
  '/:id',
  requierePermiso(PERMISOS.PROYECTOS_GESTIONAR),
  validarCuerpo(esquemaProyecto.partial()),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const datos = req.body as Partial<z.infer<typeof esquemaProyecto>>;
    const actual = await queryOne('SELECT * FROM proyectos WHERE id_proyecto = ?', [id]);
    if (!actual) throw errores.noEncontrado('el proyecto solicitado');

    if (datos.nombre) {
      const duplicado = await queryOne(
        'SELECT id_proyecto FROM proyectos WHERE nombre = ? AND id_proyecto <> ?',
        [datos.nombre, id],
      );
      if (duplicado) throw errores.conflicto('Ya existe otro proyecto con ese nombre.');
    }

    const mapa: Record<string, unknown> = {
      id_cliente: datos.id_cliente,
      nombre: datos.nombre,
      ubicacion: datos.ubicacion,
      tipo_proyecto: datos.tipo_proyecto,
      capacidad_kwp: datos.capacidad_kwp,
      fecha_inicio: datos.fecha_inicio,
      observaciones: datos.observaciones,
      activo: datos.activo === undefined ? undefined : datos.activo ? 1 : 0,
    };
    const campos = Object.entries(mapa).filter(([, v]) => v !== undefined);
    if (campos.length === 0) throw errores.solicitudInvalida('No se enviaron cambios.');

    await execute(
      `UPDATE proyectos SET ${campos.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ?
        WHERE id_proyecto = ?`,
      [...campos.map(([, v]) => v), req.usuario!.id_usuario, id],
    );

    await auditarDesdeRequest(req, {
      accion: 'PROYECTO_ACTUALIZADO',
      entidad: 'proyectos',
      idEntidad: id,
      antes: actual,
      despues: datos,
    });
    ok(res, { mensaje: 'Proyecto actualizado correctamente.' });
  }),
);

proyectosRouter.delete(
  '/:id',
  requierePermiso(PERMISOS.PROYECTOS_GESTIONAR),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const proyecto = await queryOne('SELECT * FROM proyectos WHERE id_proyecto = ?', [id]);
    if (!proyecto) throw errores.noEncontrado('el proyecto solicitado');

    const relaciones = await queryOne<{ inversores: number; produccion: number }>(
      `SELECT (SELECT COUNT(*) FROM inversores WHERE id_proyecto = ?) AS inversores,
              (SELECT COUNT(*) FROM produccion WHERE id_proyecto = ?) AS produccion`,
      [id, id],
    );

    if ((relaciones?.inversores ?? 0) > 0 || (relaciones?.produccion ?? 0) > 0) {
      await execute('UPDATE proyectos SET activo = 0, updated_by = ? WHERE id_proyecto = ?', [
        req.usuario!.id_usuario,
        id,
      ]);
      await auditarDesdeRequest(req, {
        accion: 'PROYECTO_DESACTIVADO',
        entidad: 'proyectos',
        idEntidad: id,
        antes: proyecto,
        motivo: 'Tiene inversores o produccion asociada',
      });
      ok(res, {
        eliminado: false,
        mensaje:
          'El proyecto tiene informacion asociada, por lo que fue desactivado para conservar el historico.',
      });
      return;
    }

    await execute('DELETE FROM proyectos WHERE id_proyecto = ?', [id]);
    await auditarDesdeRequest(req, {
      accion: 'PROYECTO_ELIMINADO',
      entidad: 'proyectos',
      idEntidad: id,
      antes: proyecto,
    });
    ok(res, { eliminado: true, mensaje: 'Proyecto eliminado correctamente.' });
  }),
);
