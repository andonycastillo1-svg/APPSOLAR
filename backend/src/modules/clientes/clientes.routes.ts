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
import { obtenerTexto } from '../../services/configuracion';

export const clientesRouter = Router();
clientesRouter.use(requiereAutenticacion);

const esquemaCliente = z.object({
  nombre: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres.').max(160),
  nit: z.string().trim().min(4, 'Ingrese un NIT valido.').max(30),
  ubicacion: z.string().trim().max(255).optional().nullable(),
  contacto: z.string().trim().max(120).optional().nullable(),
  telefono: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().toLowerCase().email('Ingrese un correo valido.').max(160).optional().nullable().or(z.literal('')),
  activo: z.boolean().default(true),
});

const COLUMNAS = { nombre: 'c.nombre', nit: 'c.nit', creado: 'c.created_at' };

/**
 * Validacion de NIT configurable: el patron vive en `configuracion` para no
 * imponer un formato rigido. Si el patron esta vacio solo se exige longitud.
 */
async function validarNit(nit: string): Promise<void> {
  const patron = await obtenerTexto('nit.patron', '');
  if (!patron) return;

  let expresion: RegExp;
  try {
    expresion = new RegExp(patron);
  } catch {
    // Un patron mal configurado no debe bloquear la operacion del negocio.
    return;
  }

  if (!expresion.test(nit.replace(/\s/g, ''))) {
    throw errores.validacion(
      `El NIT "${nit}" no cumple el formato configurado para la organizacion. ` +
        'Verifique el dato o ajuste el parametro "nit.patron" en Configuracion.',
    );
  }
}

clientesRouter.get(
  '/',
  requierePermiso(PERMISOS.CLIENTES_VER),
  validarConsulta(esquemaPaginacion.extend({ activo: z.enum(['1', '0']).optional() })),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquemaPaginacion> & { activo?: string }>(req);
    const { limite, desplazamiento } = limitesPaginacion(p);
    const condiciones = ['1 = 1'];
    const params: unknown[] = [];

    if (p.buscar) {
      condiciones.push('(c.nombre LIKE ? OR c.nit LIKE ? OR c.ubicacion LIKE ?)');
      params.push(`%${p.buscar}%`, `%${p.buscar}%`, `%${p.buscar}%`);
    }
    if (p.activo !== undefined) {
      condiciones.push('c.activo = ?');
      params.push(Number(p.activo));
    }

    const donde = condiciones.join(' AND ');
    const filas = await query(
      `SELECT c.*, (SELECT COUNT(*) FROM proyectos pr WHERE pr.id_cliente = c.id_cliente) AS proyectos
         FROM clientes c
        WHERE ${donde}
        ORDER BY ${columnaOrden(p.orden, COLUMNAS, 'c.nombre')} ${p.direccion === 'desc' ? 'DESC' : 'ASC'}
        LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );
    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM clientes c WHERE ${donde}`,
      params,
    );
    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

clientesRouter.get(
  '/:id',
  requierePermiso(PERMISOS.CLIENTES_VER),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cliente = await queryOne('SELECT * FROM clientes WHERE id_cliente = ?', [id]);
    if (!cliente) throw errores.noEncontrado('el cliente solicitado');

    const proyectos = await query(
      `SELECT pr.id_proyecto, pr.nombre, pr.ubicacion, pr.tipo_proyecto, pr.activo,
              (SELECT COUNT(*) FROM inversores i WHERE i.id_proyecto = pr.id_proyecto) AS inversores
         FROM proyectos pr WHERE pr.id_cliente = ? ORDER BY pr.nombre`,
      [id],
    );
    ok(res, { ...cliente, proyectos });
  }),
);

clientesRouter.post(
  '/',
  requierePermiso(PERMISOS.CLIENTES_GESTIONAR),
  validarCuerpo(esquemaCliente),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaCliente>;
    await validarNit(datos.nit);

    const duplicado = await queryOne('SELECT id_cliente FROM clientes WHERE nit = ?', [datos.nit]);
    if (duplicado) throw errores.conflicto('Ya existe un cliente registrado con ese NIT.');

    const resultado = await execute(
      `INSERT INTO clientes (nombre, nit, ubicacion, contacto, telefono, email, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        datos.nombre,
        datos.nit,
        datos.ubicacion || null,
        datos.contacto || null,
        datos.telefono || null,
        datos.email || null,
        datos.activo ? 1 : 0,
        req.usuario!.id_usuario,
      ],
    );

    await auditarDesdeRequest(req, {
      accion: 'CLIENTE_CREADO',
      entidad: 'clientes',
      idEntidad: resultado.insertId,
      despues: datos,
    });
    creado(res, { id_cliente: resultado.insertId, mensaje: 'Cliente creado correctamente.' });
  }),
);

clientesRouter.put(
  '/:id',
  requierePermiso(PERMISOS.CLIENTES_GESTIONAR),
  validarCuerpo(esquemaCliente.partial()),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const datos = req.body as Partial<z.infer<typeof esquemaCliente>>;
    const actual = await queryOne('SELECT * FROM clientes WHERE id_cliente = ?', [id]);
    if (!actual) throw errores.noEncontrado('el cliente solicitado');

    if (datos.nit) {
      await validarNit(datos.nit);
      const duplicado = await queryOne(
        'SELECT id_cliente FROM clientes WHERE nit = ? AND id_cliente <> ?',
        [datos.nit, id],
      );
      if (duplicado) throw errores.conflicto('Ya existe otro cliente con ese NIT.');
    }

    const mapa: Record<string, unknown> = {
      nombre: datos.nombre,
      nit: datos.nit,
      ubicacion: datos.ubicacion,
      contacto: datos.contacto,
      telefono: datos.telefono,
      email: datos.email,
      activo: datos.activo === undefined ? undefined : datos.activo ? 1 : 0,
    };
    const campos = Object.entries(mapa).filter(([, v]) => v !== undefined);
    if (campos.length === 0) throw errores.solicitudInvalida('No se enviaron cambios.');

    await execute(
      `UPDATE clientes SET ${campos.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ?
        WHERE id_cliente = ?`,
      [...campos.map(([, v]) => v), req.usuario!.id_usuario, id],
    );

    await auditarDesdeRequest(req, {
      accion: 'CLIENTE_ACTUALIZADO',
      entidad: 'clientes',
      idEntidad: id,
      antes: actual,
      despues: datos,
    });
    ok(res, { mensaje: 'Cliente actualizado correctamente.' });
  }),
);

/**
 * Baja logica. Solo se permite la eliminacion fisica cuando no existe ninguna
 * relacion; en cualquier otro caso se desactiva para conservar la trazabilidad.
 */
clientesRouter.delete(
  '/:id',
  requierePermiso(PERMISOS.CLIENTES_GESTIONAR),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cliente = await queryOne('SELECT * FROM clientes WHERE id_cliente = ?', [id]);
    if (!cliente) throw errores.noEncontrado('el cliente solicitado');

    const relacionados = await queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM proyectos WHERE id_cliente = ?',
      [id],
    );

    if ((relacionados?.total ?? 0) > 0) {
      await execute('UPDATE clientes SET activo = 0, updated_by = ? WHERE id_cliente = ?', [
        req.usuario!.id_usuario,
        id,
      ]);
      await auditarDesdeRequest(req, {
        accion: 'CLIENTE_DESACTIVADO',
        entidad: 'clientes',
        idEntidad: id,
        antes: cliente,
        motivo: 'Tiene proyectos asociados',
      });
      ok(res, {
        eliminado: false,
        mensaje: `El cliente tiene ${relacionados?.total} proyecto(s) asociado(s), por lo que fue desactivado en lugar de eliminarse.`,
      });
      return;
    }

    await execute('DELETE FROM clientes WHERE id_cliente = ?', [id]);
    await auditarDesdeRequest(req, {
      accion: 'CLIENTE_ELIMINADO',
      entidad: 'clientes',
      idEntidad: id,
      antes: cliente,
    });
    ok(res, { eliminado: true, mensaje: 'Cliente eliminado correctamente.' });
  }),
);
