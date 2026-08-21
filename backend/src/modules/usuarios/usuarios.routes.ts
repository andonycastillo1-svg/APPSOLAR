import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction } from '../../db/pool';
import { errores } from '../../utils/errors';
import {
  asyncHandler,
  consulta,
  creado,
  esquemaPaginacion,
  limitesPaginacion,
  metaPaginacion,
  columnaOrden,
  ok,
  validarConsulta,
  validarCuerpo,
} from '../../utils/http';
import { requiereAutenticacion, requierePermiso } from '../../middleware/autenticacion';
import { PERMISOS, PERMISOS_SOLO_ESCRITURA } from '../../config/permisos';
import { auditarDesdeRequest } from '../../services/auditoria';
import {
  generarPasswordTemporal,
  hashPassword,
  permisosEfectivos,
  revocarSesionesUsuario,
  validarFortalezaPassword,
} from '../../services/auth';

export const usuariosRouter = Router();
usuariosRouter.use(requiereAutenticacion);

const ROLES = ['ADMINISTRATIVO', 'OPERATIVO', 'GERENCIAL'] as const;

const esquemaCrear = z.object({
  nombre: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres.').max(120),
  email: z.string().trim().toLowerCase().email('Ingrese un correo electronico valido.').max(160),
  rol: z.enum(ROLES, { errorMap: () => ({ message: 'Seleccione un rol valido.' }) }),
  telefono: z.string().trim().max(40).optional().nullable(),
  password: z.string().max(200).optional(),
  activo: z.boolean().default(true),
});

const esquemaActualizar = z.object({
  nombre: z.string().trim().min(3).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(160).optional(),
  rol: z.enum(ROLES).optional(),
  telefono: z.string().trim().max(40).optional().nullable(),
  activo: z.boolean().optional(),
});

const esquemaPermisos = z.object({
  otorgados: z.array(z.string().max(60)).default([]),
  revocados: z.array(z.string().max(60)).default([]),
});

const COLUMNAS_ORDEN = {
  nombre: 'u.nombre',
  email: 'u.email',
  rol: 'r.codigo',
  ultimoAcceso: 'u.ultimo_acceso',
  creado: 'u.created_at',
};

// ---------------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------------
usuariosRouter.get(
  '/',
  requierePermiso(PERMISOS.USUARIOS_VER),
  validarConsulta(
    esquemaPaginacion.extend({
      rol: z.enum(ROLES).optional(),
      activo: z.enum(['1', '0']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const p = consulta<z.infer<typeof esquemaPaginacion> & { rol?: string; activo?: string }>(req);
    const { limite, desplazamiento } = limitesPaginacion(p);

    const condiciones: string[] = ['1 = 1'];
    const params: unknown[] = [];

    if (p.buscar) {
      condiciones.push('(u.nombre LIKE ? OR u.email LIKE ?)');
      params.push(`%${p.buscar}%`, `%${p.buscar}%`);
    }
    if (p.rol) {
      condiciones.push('r.codigo = ?');
      params.push(p.rol);
    }
    if (p.activo !== undefined) {
      condiciones.push('u.activo = ?');
      params.push(Number(p.activo));
    }

    const donde = condiciones.join(' AND ');
    const orden = columnaOrden(p.orden, COLUMNAS_ORDEN, 'u.nombre');
    const direccion = p.direccion === 'desc' ? 'DESC' : 'ASC';

    const filas = await query(
      `SELECT u.id_usuario, u.nombre, u.email, u.telefono, u.activo,
              u.ultimo_acceso, u.debe_cambiar_password, u.es_demo,
              u.created_at, r.codigo AS rol, r.nombre AS rol_nombre
         FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol
        WHERE ${donde}
        ORDER BY ${orden} ${direccion}
        LIMIT ? OFFSET ?`,
      [...params, limite, desplazamiento],
    );

    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol WHERE ${donde}`,
      params,
    );

    ok(res, filas, metaPaginacion(p, total?.total ?? 0));
  }),
);

// ---------------------------------------------------------------------------
// GET /users/roles  (catalogo)
// ---------------------------------------------------------------------------
usuariosRouter.get(
  '/roles',
  requierePermiso(PERMISOS.USUARIOS_VER),
  asyncHandler(async (_req, res) => {
    const roles = await query('SELECT id_rol, codigo, nombre, descripcion FROM roles ORDER BY id_rol');
    const permisos = await query(
      'SELECT id_permiso, codigo, modulo, descripcion FROM permisos ORDER BY modulo, codigo',
    );
    ok(res, { roles, permisos });
  }),
);

// ---------------------------------------------------------------------------
// GET /users/:id
// ---------------------------------------------------------------------------
usuariosRouter.get(
  '/:id',
  requierePermiso(PERMISOS.USUARIOS_VER),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = await queryOne(
      `SELECT u.id_usuario, u.nombre, u.email, u.telefono, u.activo, u.ultimo_acceso,
              u.debe_cambiar_password, u.created_at, u.updated_at,
              r.codigo AS rol, r.nombre AS rol_nombre
         FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol
        WHERE u.id_usuario = ?`,
      [id],
    );
    if (!usuario) throw errores.noEncontrado('el usuario solicitado');

    const individuales = await query(
      `SELECT p.codigo, up.otorgado
         FROM usuario_permisos up JOIN permisos p ON p.id_permiso = up.id_permiso
        WHERE up.id_usuario = ?`,
      [id],
    );

    ok(res, {
      ...usuario,
      permisosEfectivos: await permisosEfectivos(id),
      permisosIndividuales: individuales,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /users
// ---------------------------------------------------------------------------
usuariosRouter.post(
  '/',
  requierePermiso(PERMISOS.USUARIOS_GESTIONAR),
  validarCuerpo(esquemaCrear),
  asyncHandler(async (req, res) => {
    const datos = req.body as z.infer<typeof esquemaCrear>;

    const existente = await queryOne('SELECT id_usuario FROM usuarios WHERE email = ?', [datos.email]);
    if (existente) throw errores.conflicto('Ya existe un usuario con ese correo electronico.');

    const rol = await queryOne<{ id_rol: number }>('SELECT id_rol FROM roles WHERE codigo = ?', [
      datos.rol,
    ]);
    if (!rol) throw errores.validacion('El rol indicado no existe.');

    const passwordInicial = datos.password || generarPasswordTemporal();
    if (datos.password) {
      const problemas = validarFortalezaPassword(datos.password);
      if (problemas.length > 0) {
        throw errores.validacion('La contrasena no cumple la politica de seguridad.', {
          requisitos: problemas,
        });
      }
    }

    const resultado = await execute(
      `INSERT INTO usuarios
         (nombre, email, password_hash, id_rol, telefono, activo, debe_cambiar_password, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        datos.nombre,
        datos.email,
        await hashPassword(passwordInicial),
        rol.id_rol,
        datos.telefono ?? null,
        datos.activo ? 1 : 0,
        req.usuario!.id_usuario,
      ],
    );

    await auditarDesdeRequest(req, {
      accion: 'USUARIO_CREADO',
      entidad: 'usuarios',
      idEntidad: resultado.insertId,
      despues: { ...datos, password: undefined },
    });

    creado(res, {
      id_usuario: resultado.insertId,
      // Se entrega una sola vez al administrador para su comunicacion segura.
      passwordTemporal: datos.password ? undefined : passwordInicial,
      mensaje: datos.password
        ? 'Usuario creado. Debera cambiar la contrasena en su primer ingreso.'
        : 'Usuario creado. Entregue la contrasena temporal por un medio seguro.',
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /users/:id
// ---------------------------------------------------------------------------
usuariosRouter.put(
  '/:id',
  requierePermiso(PERMISOS.USUARIOS_GESTIONAR),
  validarCuerpo(esquemaActualizar),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const datos = req.body as z.infer<typeof esquemaActualizar>;

    const actual = await queryOne<{
      id_usuario: number;
      nombre: string;
      email: string;
      activo: number;
      id_rol: number;
      rol: string;
    }>(
      `SELECT u.id_usuario, u.nombre, u.email, u.activo, u.id_rol, r.codigo AS rol
         FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol WHERE u.id_usuario = ?`,
      [id],
    );
    if (!actual) throw errores.noEncontrado('el usuario solicitado');

    // Regla: el ultimo administrador activo no puede desactivarse ni cambiar de rol.
    const quedaSinAdmin =
      (datos.activo === false || (datos.rol && datos.rol !== 'ADMINISTRATIVO')) &&
      actual.rol === 'ADMINISTRATIVO';

    if (quedaSinAdmin) {
      const restantes = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol
          WHERE r.codigo = 'ADMINISTRATIVO' AND u.activo = 1 AND u.id_usuario <> ?`,
        [id],
      );
      if ((restantes?.total ?? 0) === 0) {
        throw errores.reglaNegocio(
          'No es posible dejar el sistema sin usuarios administrativos activos.',
        );
      }
    }

    if (datos.activo === false && id === req.usuario!.id_usuario) {
      throw errores.reglaNegocio('No puede desactivar su propio usuario.');
    }

    const campos: string[] = [];
    const params: unknown[] = [];

    if (datos.nombre !== undefined) {
      campos.push('nombre = ?');
      params.push(datos.nombre);
    }
    if (datos.email !== undefined) {
      const duplicado = await queryOne(
        'SELECT id_usuario FROM usuarios WHERE email = ? AND id_usuario <> ?',
        [datos.email, id],
      );
      if (duplicado) throw errores.conflicto('Ya existe otro usuario con ese correo electronico.');
      campos.push('email = ?');
      params.push(datos.email);
    }
    if (datos.telefono !== undefined) {
      campos.push('telefono = ?');
      params.push(datos.telefono);
    }
    if (datos.activo !== undefined) {
      campos.push('activo = ?');
      params.push(datos.activo ? 1 : 0);
    }
    if (datos.rol !== undefined) {
      const rol = await queryOne<{ id_rol: number }>('SELECT id_rol FROM roles WHERE codigo = ?', [
        datos.rol,
      ]);
      if (!rol) throw errores.validacion('El rol indicado no existe.');
      campos.push('id_rol = ?');
      params.push(rol.id_rol);
    }

    if (campos.length === 0) throw errores.solicitudInvalida('No se enviaron cambios.');

    campos.push('updated_by = ?');
    params.push(req.usuario!.id_usuario, id);

    await execute(`UPDATE usuarios SET ${campos.join(', ')} WHERE id_usuario = ?`, params);

    // Al desactivar o cambiar de rol se revocan las sesiones vigentes.
    if (datos.activo === false || datos.rol !== undefined) {
      await revocarSesionesUsuario(id, datos.activo === false ? 'USUARIO_DESACTIVADO' : 'CAMBIO_ROL');
    }

    await auditarDesdeRequest(req, {
      accion: 'USUARIO_ACTUALIZADO',
      entidad: 'usuarios',
      idEntidad: id,
      antes: actual,
      despues: datos,
    });

    ok(res, { mensaje: 'Usuario actualizado correctamente.' });
  }),
);

// ---------------------------------------------------------------------------
// POST /users/:id/reset-password
// ---------------------------------------------------------------------------
usuariosRouter.post(
  '/:id/reset-password',
  requierePermiso(PERMISOS.USUARIOS_GESTIONAR),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = await queryOne<{ id_usuario: number; email: string }>(
      'SELECT id_usuario, email FROM usuarios WHERE id_usuario = ?',
      [id],
    );
    if (!usuario) throw errores.noEncontrado('el usuario solicitado');

    const temporal = generarPasswordTemporal();
    await execute(
      `UPDATE usuarios
          SET password_hash = ?, debe_cambiar_password = 1, intentos_fallidos = 0,
              bloqueado_hasta = NULL, password_actualizado_en = NOW(), updated_by = ?
        WHERE id_usuario = ?`,
      [await hashPassword(temporal), req.usuario!.id_usuario, id],
    );
    await revocarSesionesUsuario(id, 'RESTABLECIMIENTO_ADMIN');

    await auditarDesdeRequest(req, {
      accion: 'PASSWORD_RESTABLECIDA',
      entidad: 'usuarios',
      idEntidad: id,
      motivo: 'Restablecimiento administrativo',
    });

    // La contrasena anterior nunca se revela ni se registra.
    ok(res, {
      passwordTemporal: temporal,
      mensaje:
        'Contrasena restablecida. Entreguela por un medio seguro; el usuario debera cambiarla al ingresar.',
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /users/:id/permissions  (permisos individuales, p.ej. tarifas.gestionar)
// ---------------------------------------------------------------------------
usuariosRouter.put(
  '/:id/permissions',
  requierePermiso(PERMISOS.USUARIOS_GESTIONAR),
  validarCuerpo(esquemaPermisos),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { otorgados, revocados } = req.body as z.infer<typeof esquemaPermisos>;

    const usuario = await queryOne<{ rol: string }>(
      'SELECT r.codigo AS rol FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol WHERE u.id_usuario = ?',
      [id],
    );
    if (!usuario) throw errores.noEncontrado('el usuario solicitado');

    // Un usuario gerencial nunca puede recibir permisos de escritura.
    if (usuario.rol === 'GERENCIAL') {
      const invalido = otorgados.find((p) => PERMISOS_SOLO_ESCRITURA.includes(p as never));
      if (invalido) {
        throw errores.reglaNegocio(
          `El rol gerencial es de solo lectura y no puede recibir el permiso "${invalido}".`,
        );
      }
    }

    const codigos = [...new Set([...otorgados, ...revocados])];
    const existentes = codigos.length
      ? await query<{ id_permiso: number; codigo: string }>(
          `SELECT id_permiso, codigo FROM permisos WHERE codigo IN (${codigos.map(() => '?').join(',')})`,
          codigos,
        )
      : [];
    const mapa = new Map(existentes.map((p) => [p.codigo, p.id_permiso]));

    const desconocido = codigos.find((c) => !mapa.has(c));
    if (desconocido) throw errores.validacion(`El permiso "${desconocido}" no existe.`);

    const anteriores = await query(
      `SELECT p.codigo, up.otorgado FROM usuario_permisos up
         JOIN permisos p ON p.id_permiso = up.id_permiso WHERE up.id_usuario = ?`,
      [id],
    );

    await withTransaction(async (conn) => {
      await execute('DELETE FROM usuario_permisos WHERE id_usuario = ?', [id], conn);
      for (const codigo of otorgados) {
        await execute(
          `INSERT INTO usuario_permisos (id_usuario, id_permiso, otorgado, asignado_por)
           VALUES (?, ?, 1, ?)`,
          [id, mapa.get(codigo), req.usuario!.id_usuario],
          conn,
        );
      }
      for (const codigo of revocados) {
        if (otorgados.includes(codigo)) continue;
        await execute(
          `INSERT INTO usuario_permisos (id_usuario, id_permiso, otorgado, asignado_por)
           VALUES (?, ?, 0, ?)`,
          [id, mapa.get(codigo), req.usuario!.id_usuario],
          conn,
        );
      }
    });

    await auditarDesdeRequest(req, {
      accion: 'PERMISOS_ACTUALIZADOS',
      entidad: 'usuarios',
      idEntidad: id,
      antes: anteriores,
      despues: { otorgados, revocados },
    });

    ok(res, {
      permisosEfectivos: await permisosEfectivos(id),
      mensaje: 'Permisos individuales actualizados.',
    });
  }),
);
