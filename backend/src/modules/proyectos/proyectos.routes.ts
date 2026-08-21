import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../../db/pool';
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

const COLUMNAS = {
  nombre: 'pr.nombre',
  cliente: 'c.nombre',
  tipo: 'pr.tipo_proyecto',
  creado: 'pr.created_at',
};

// Submodulos anidados: tarifas y proyecciones pertenecen al proyecto.
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

    const inversores = await query(
      `SELECT i.*, (SELECT MAX(p.fecha) FROM produccion p WHERE p.id_inversor = i.id_inversor AND p.activo = 1) AS ultima_produccion
         FROM inversores i WHERE i.id_proyecto = ? ORDER BY i.marca, i.modelo`,
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
      `SELECT anio, mes, costo_kwh, estado FROM tarifas_kwh
        WHERE id_proyecto = ? AND estado <> 'ANULADA' ORDER BY anio DESC, mes DESC LIMIT 24`,
      [id],
    );

    ok(res, { ...proyecto, inversores, resumen, tarifasRecientes: tarifas });
  }),
);

proyectosRouter.post(
  '/',
  requierePermiso(PERMISOS.PROYECTOS_GESTIONAR),
  validarCuerpo(esquemaProyecto),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaProyecto>;

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

    const resultado = await execute(
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
    );

    await auditarDesdeRequest(req, {
      accion: 'PROYECTO_CREADO',
      entidad: 'proyectos',
      idEntidad: resultado.insertId,
      despues: datos,
    });
    creado(res, { id_proyecto: resultado.insertId, mensaje: 'Proyecto creado correctamente.' });
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
