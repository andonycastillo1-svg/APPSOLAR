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

export const inversoresRouter = Router();

/** Integracion Huawei registrada (el sistema maneja una sola). */
async function integracionHuawei(): Promise<number | null> {
  const fila = await queryOne<{ id_api: number }>(
    "SELECT id_api FROM apis_fabricante WHERE marca = 'HUAWEI' ORDER BY id_api LIMIT 1",
  );
  return fila?.id_api ?? null;
}
inversoresRouter.use(requiereAutenticacion);

const CONEXIONES = ['MANUAL', 'HUAWEI_API'] as const;
const ESTADOS = ['ACTIVO', 'INACTIVO', 'MANTENIMIENTO'] as const;

const esquemaInversor = z.object({
  id_proyecto: z.coerce.number().int().positive('Seleccione el proyecto al que pertenece el inversor.'),
  // Jerarquia PROYECTO -> GRUPO -> INVERSOR: todo inversor pertenece a un grupo.
  id_grupo: z.coerce
    .number({ invalid_type_error: 'Seleccione el grupo al que pertenece el inversor.' })
    .int()
    .positive('Seleccione el grupo al que pertenece el inversor.'),
  marca: z.string().trim().min(2, 'Indique la marca del inversor.').max(60),
  modelo: z.string().trim().min(1, 'Indique el modelo del inversor.').max(80),
  tipo_conexion: z.enum(CONEXIONES).default('MANUAL'),
  serial_externo: z.string().trim().max(80).optional().nullable(),
  estacion_externa: z.string().trim().max(80).optional().nullable(),
  capacidad_kwp: z.coerce.number().min(0, 'La potencia instalada no puede ser negativa.').optional().nullable(),
  estado: z.enum(ESTADOS).default('ACTIVO'),
  id_api: z.coerce.number().int().positive().optional().nullable(),
  observaciones: z.string().trim().max(500).optional().nullable(),
  activo: z.boolean().default(true),
});

const COLUMNAS = {
  marca: 'i.marca',
  modelo: 'i.modelo',
  proyecto: 'pr.nombre',
  estado: 'i.estado',
  actualizacion: 'i.ultima_actualizacion',
};

inversoresRouter.get(
  '/',
  requierePermiso(PERMISOS.INVERSORES_VER),
  validarConsulta(
    esquemaPaginacion.extend({
      id_proyecto: z.coerce.number().int().positive().optional(),
      id_grupo: z.coerce.number().int().positive().optional(),
      id_cliente: z.coerce.number().int().positive().optional(),
      tipo_conexion: z.enum(CONEXIONES).optional(),
      estado: z.enum(ESTADOS).optional(),
      activo: z.enum(['1', '0']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<
      z.infer<typeof esquemaPaginacion> & {
        id_proyecto?: number;
        id_grupo?: number;
        id_cliente?: number;
        tipo_conexion?: string;
        estado?: string;
        activo?: string;
      }
    >(req);
    const { limite, desplazamiento } = limitesPaginacion(p);
    const condiciones = ['1 = 1'];
    const params: unknown[] = [];

    if (p.buscar) {
      condiciones.push('(i.marca LIKE ? OR i.modelo LIKE ? OR i.serial_externo LIKE ? OR pr.nombre LIKE ?)');
      params.push(`%${p.buscar}%`, `%${p.buscar}%`, `%${p.buscar}%`, `%${p.buscar}%`);
    }
    if (p.id_proyecto) {
      condiciones.push('i.id_proyecto = ?');
      params.push(p.id_proyecto);
    }
    if (p.id_grupo) {
      condiciones.push('i.id_grupo = ?');
      params.push(p.id_grupo);
    }
    if (p.id_cliente) {
      condiciones.push('pr.id_cliente = ?');
      params.push(p.id_cliente);
    }
    if (p.tipo_conexion) {
      condiciones.push('i.tipo_conexion = ?');
      params.push(p.tipo_conexion);
    }
    if (p.estado) {
      condiciones.push('i.estado = ?');
      params.push(p.estado);
    }
    if (p.activo !== undefined) {
      condiciones.push('i.activo = ?');
      params.push(Number(p.activo));
    }

    const donde = condiciones.join(' AND ');
    const filas = await query(
      `SELECT i.*, pr.nombre AS proyecto, pr.id_cliente, c.nombre AS cliente,
              g.nombre AS grupo, g.tiene_banco_baterias,
              (SELECT COALESCE(SUM(p.kwh), 0) FROM produccion p
                WHERE p.id_inversor = i.id_inversor AND p.activo = 1) AS kwh_total,
              (SELECT MAX(p.fecha) FROM produccion p
                WHERE p.id_inversor = i.id_inversor AND p.activo = 1) AS ultima_produccion
         FROM inversores i
         JOIN proyectos pr ON pr.id_proyecto = i.id_proyecto
         JOIN clientes c ON c.id_cliente = pr.id_cliente
         JOIN grupos g ON g.id_grupo = i.id_grupo
        WHERE ${donde}
        ORDER BY ${columnaOrden(p.orden, COLUMNAS, 'pr.nombre')} ${p.direccion === 'desc' ? 'DESC' : 'ASC'}, i.marca
        LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );

    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM inversores i
         JOIN proyectos pr ON pr.id_proyecto = i.id_proyecto
         JOIN grupos g ON g.id_grupo = i.id_grupo WHERE ${donde}`,
      params,
    );

    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

inversoresRouter.get(
  '/:id',
  requierePermiso(PERMISOS.INVERSORES_VER),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const inversor = await queryOne(
      `SELECT i.*, pr.nombre AS proyecto, pr.id_cliente, c.nombre AS cliente,
              g.nombre AS grupo, g.tiene_banco_baterias, g.capacidad_baterias_kwh,
              a.marca AS api_marca, a.nombre AS api_nombre, a.modo AS api_modo, a.estado AS api_estado
         FROM inversores i
         JOIN proyectos pr ON pr.id_proyecto = i.id_proyecto
         JOIN clientes c ON c.id_cliente = pr.id_cliente
         JOIN grupos g ON g.id_grupo = i.id_grupo
         LEFT JOIN apis_fabricante a ON a.id_api = i.id_api
        WHERE i.id_inversor = ?`,
      [id],
    );
    if (!inversor) throw errores.noEncontrado('el inversor solicitado');

    const produccionMensual = await query(
      `SELECT anio, mes, COALESCE(SUM(kwh), 0) AS kwh, COALESCE(SUM(valor_q), 0) AS valor_q,
              SUM(estado_valorizacion = 'PENDIENTE_DE_TARIFA') AS pendientes
         FROM produccion WHERE id_inversor = ? AND activo = 1
        GROUP BY anio, mes ORDER BY anio DESC, mes DESC LIMIT 24`,
      [id],
    );

    const importaciones = await query(
      `SELECT id_historico, nombre_archivo_original, estado, total_filas, insertadas,
              actualizadas, rechazadas, created_at
         FROM historicos WHERE id_inversor = ? ORDER BY created_at DESC LIMIT 10`,
      [id],
    );

    const sincronizaciones = await query(
      `SELECT id_sync, tipo, modo, estado, rango_desde, rango_hasta, filas_recibidas,
              insertadas, actualizadas, rechazadas, codigo_error, mensaje, iniciada_en, duracion_ms
         FROM sincronizaciones WHERE id_inversor = ? ORDER BY iniciada_en DESC LIMIT 10`,
      [id],
    );

    ok(res, { ...inversor, produccionMensual, importaciones, sincronizaciones });
  }),
);

inversoresRouter.post(
  '/',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  validarCuerpo(esquemaInversor),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaInversor>;

    // Regla de negocio: no se puede crear un inversor sin proyecto.
    const proyecto = await queryOne<{ activo: number }>(
      'SELECT activo FROM proyectos WHERE id_proyecto = ?',
      [datos.id_proyecto],
    );
    if (!proyecto) throw errores.validacion('El proyecto indicado no existe.');
    if (!proyecto.activo) {
      throw errores.reglaNegocio('No es posible agregar inversores a un proyecto desactivado.');
    }

    // El grupo debe existir, estar activo y pertenecer al mismo proyecto.
    const grupo = await queryOne<{ id_proyecto: number; activo: number; nombre: string }>(
      'SELECT id_proyecto, activo, nombre FROM grupos WHERE id_grupo = ?',
      [datos.id_grupo],
    );
    if (!grupo) throw errores.validacion('El grupo indicado no existe.');
    if (grupo.id_proyecto !== datos.id_proyecto) {
      throw errores.validacion('El grupo seleccionado no pertenece al proyecto indicado.');
    }
    if (!grupo.activo) {
      throw errores.reglaNegocio('No es posible agregar inversores a un grupo desactivado.');
    }

    if (datos.tipo_conexion === 'HUAWEI_API' && !datos.serial_externo) {
      throw errores.validacion(
        'Un inversor con conexion HUAWEI_API requiere el identificador externo (serial o deviceDn) para poder sincronizarse.',
      );
    }

    if (datos.serial_externo) {
      const duplicado = await queryOne(
        'SELECT id_inversor FROM inversores WHERE id_proyecto = ? AND serial_externo = ?',
        [datos.id_proyecto, datos.serial_externo],
      );
      if (duplicado) {
        throw errores.conflicto('Ya existe un inversor con ese identificador externo en el proyecto.');
      }
    }

    const idApi =
      datos.id_api ?? (datos.tipo_conexion === 'HUAWEI_API' ? await integracionHuawei() : null);

    const resultado = await execute(
      `INSERT INTO inversores
         (id_proyecto, id_grupo, marca, modelo, tipo_conexion, serial_externo, estacion_externa,
          capacidad_kwp, estado, id_api, observaciones, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.id_proyecto,
        datos.id_grupo,
        datos.marca,
        datos.modelo,
        datos.tipo_conexion,
        datos.serial_externo || null,
        datos.estacion_externa || null,
        datos.capacidad_kwp ?? null,
        datos.estado,
        idApi,
        datos.observaciones || null,
        datos.activo ? 1 : 0,
        req.usuario!.id_usuario,
      ],
    );

    await auditarDesdeRequest(req, {
      accion: 'INVERSOR_CREADO',
      entidad: 'inversores',
      idEntidad: resultado.insertId,
      despues: datos,
    });
    creado(res, { id_inversor: resultado.insertId, mensaje: 'Inversor creado correctamente.' });
  }),
);

inversoresRouter.put(
  '/:id',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  validarCuerpo(esquemaInversor.partial()),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const datos = req.body as Partial<z.infer<typeof esquemaInversor>>;
    const actual = await queryOne<{
      id_proyecto: number;
      tipo_conexion: string;
      id_api: number | null;
    }>('SELECT * FROM inversores WHERE id_inversor = ?', [id]);
    if (!actual) throw errores.noEncontrado('el inversor solicitado');

    // Un inversor Huawei queda asociado a la integracion sin pedirselo al usuario.
    const tipoFinal = datos.tipo_conexion ?? actual.tipo_conexion;
    const apiFinal = datos.id_api !== undefined ? datos.id_api : actual.id_api;
    if (tipoFinal === 'HUAWEI_API' && !apiFinal) {
      datos.id_api = await integracionHuawei();
    }

    if (datos.serial_externo) {
      const duplicado = await queryOne(
        'SELECT id_inversor FROM inversores WHERE id_proyecto = ? AND serial_externo = ? AND id_inversor <> ?',
        [datos.id_proyecto ?? actual.id_proyecto, datos.serial_externo, id],
      );
      if (duplicado) {
        throw errores.conflicto('Ya existe otro inversor con ese identificador externo en el proyecto.');
      }
    }

    const mapa: Record<string, unknown> = {
      id_proyecto: datos.id_proyecto,
      id_grupo: datos.id_grupo,
      marca: datos.marca,
      modelo: datos.modelo,
      tipo_conexion: datos.tipo_conexion,
      serial_externo: datos.serial_externo,
      estacion_externa: datos.estacion_externa,
      capacidad_kwp: datos.capacidad_kwp,
      estado: datos.estado,
      id_api: datos.id_api,
      observaciones: datos.observaciones,
      activo: datos.activo === undefined ? undefined : datos.activo ? 1 : 0,
    };
    const campos = Object.entries(mapa).filter(([, v]) => v !== undefined);
    if (campos.length === 0) throw errores.solicitudInvalida('No se enviaron cambios.');

    await execute(
      `UPDATE inversores SET ${campos.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ?
        WHERE id_inversor = ?`,
      [...campos.map(([, v]) => v), req.usuario!.id_usuario, id],
    );

    await auditarDesdeRequest(req, {
      accion: 'INVERSOR_ACTUALIZADO',
      entidad: 'inversores',
      idEntidad: id,
      antes: actual,
      despues: datos,
    });
    ok(res, { mensaje: 'Inversor actualizado correctamente.' });
  }),
);

inversoresRouter.delete(
  '/:id',
  requierePermiso(PERMISOS.INVERSORES_GESTIONAR),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const inversor = await queryOne('SELECT * FROM inversores WHERE id_inversor = ?', [id]);
    if (!inversor) throw errores.noEncontrado('el inversor solicitado');

    const produccion = await queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM produccion WHERE id_inversor = ?',
      [id],
    );

    if ((produccion?.total ?? 0) > 0) {
      await execute(
        "UPDATE inversores SET activo = 0, estado = 'INACTIVO', updated_by = ? WHERE id_inversor = ?",
        [req.usuario!.id_usuario, id],
      );
      await auditarDesdeRequest(req, {
        accion: 'INVERSOR_DESACTIVADO',
        entidad: 'inversores',
        idEntidad: id,
        antes: inversor,
        motivo: 'Tiene produccion registrada',
      });
      ok(res, {
        eliminado: false,
        mensaje: `El inversor tiene ${produccion?.total} registro(s) de produccion, por lo que fue desactivado para conservar el historico.`,
      });
      return;
    }

    await execute('DELETE FROM inversores WHERE id_inversor = ?', [id]);
    await auditarDesdeRequest(req, {
      accion: 'INVERSOR_ELIMINADO',
      entidad: 'inversores',
      idEntidad: id,
      antes: inversor,
    });
    ok(res, { eliminado: true, mensaje: 'Inversor eliminado correctamente.' });
  }),
);
