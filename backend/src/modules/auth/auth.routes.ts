import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { execute, queryOne } from '../../db/pool';
import { AppError, errores } from '../../utils/errors';
import { asyncHandler, ok, validarCuerpo } from '../../utils/http';
import { registrarAuditoria, auditarDesdeRequest } from '../../services/auditoria';
import {
  COOKIE_REFRESCO,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  construirUsuarioAutenticado,
  emitirRefreshToken,
  establecerCookiesSesion,
  firmarTokenAcceso,
  hashPassword,
  limpiarCookiesSesion,
  revocarSesionesUsuario,
  revocarToken,
  validarFortalezaPassword,
  validarRefreshToken,
  verificarPassword,
} from '../../services/auth';
import { requiereAutenticacion } from '../../middleware/autenticacion';

export const authRouter = Router();

/** Limitador especifico para el inicio de sesion (defensa contra fuerza bruta). */
const limitadorLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    error: {
      codigo: 'LIMITE_SOLICITUDES',
      mensaje: 'Demasiados intentos de inicio de sesion. Espere unos minutos e intente de nuevo.',
    },
  },
});

const esquemaLogin = z.object({
  email: z.string().trim().toLowerCase().email('Ingrese un correo electronico valido.'),
  password: z.string().min(1, 'Ingrese su contraseña.').max(200),
});

const esquemaCambioPassword = z.object({
  passwordActual: z.string().min(1, 'Ingrese su contraseña actual.').max(200),
  passwordNueva: z.string().min(1, 'Ingrese la nueva contraseña.').max(200),
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
authRouter.post(
  '/login',
  limitadorLogin,
  validarCuerpo(esquemaLogin),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof esquemaLogin>;
    const registro = await buscarUsuarioPorEmail(email);

    const fallo = async (motivo: string) => {
      await registrarAuditoria({
        idUsuario: registro?.id_usuario ?? null,
        usuarioEmail: email,
        accion: 'AUTENTICACION_FALLIDA',
        entidad: 'usuarios',
        idEntidad: registro?.id_usuario ?? null,
        resultado: 'FALLO',
        motivo,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        correlationId: req.correlationId,
      });
    };

    // Respuesta uniforme: no se revela si el correo existe o no.
    const credencialesInvalidas = errores.noAutenticado(
      'Correo o contraseña incorrectos.',
    );

    if (!registro) {
      await fallo('Usuario inexistente');
      throw credencialesInvalidas;
    }

    if (registro.bloqueado_hasta) {
      const bloqueo = await queryOne<{ vigente: number }>(
        'SELECT (bloqueado_hasta > NOW()) AS vigente FROM usuarios WHERE id_usuario = ?',
        [registro.id_usuario],
      );
      if (bloqueo?.vigente) {
        await fallo('Usuario bloqueado temporalmente');
        throw new AppError(
          429,
          'USUARIO_BLOQUEADO',
          `Su usuario esta bloqueado temporalmente por intentos fallidos. Intente despues de ${env.auth.loginLockMinutes} minutos.`,
        );
      }
    }

    if (!registro.activo) {
      await fallo('Usuario inactivo');
      throw errores.noAutenticado(
        'Su usuario esta desactivado. Contacte al administrador del sistema.',
      );
    }

    const valida = await verificarPassword(password, registro.password_hash);
    if (!valida) {
      const intentos = registro.intentos_fallidos + 1;
      const bloquear = intentos >= env.auth.loginMaxAttempts;
      await execute(
        `UPDATE usuarios
            SET intentos_fallidos = ?,
                bloqueado_hasta = ${bloquear ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'}
          WHERE id_usuario = ?`,
        bloquear
          ? [intentos, env.auth.loginLockMinutes, registro.id_usuario]
          : [intentos, registro.id_usuario],
      );
      await fallo(bloquear ? 'Contraseña incorrecta (bloqueo aplicado)' : 'Contraseña incorrecta');
      throw credencialesInvalidas;
    }

    await execute(
      `UPDATE usuarios
          SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = NOW()
        WHERE id_usuario = ?`,
      [registro.id_usuario],
    );

    const usuario = await construirUsuarioAutenticado(registro);
    const refresco = await emitirRefreshToken(
      usuario.id_usuario,
      null,
      req.ip,
      req.get('user-agent'),
    );
    const csrf = establecerCookiesSesion(res, firmarTokenAcceso(usuario), refresco.token);

    await registrarAuditoria({
      idUsuario: usuario.id_usuario,
      usuarioEmail: usuario.email,
      accion: 'INICIO_SESION',
      entidad: 'usuarios',
      idEntidad: usuario.id_usuario,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      correlationId: req.correlationId,
    });

    ok(res, {
      usuario,
      csrfToken: csrf,
      debeCambiarPassword: Boolean(registro.debe_cambiar_password),
      expiraEnMinutos: env.auth.accessTtlMin,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /auth/refresh  (rotacion de refresh token)
// ---------------------------------------------------------------------------
authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[COOKIE_REFRESCO] || req.body?.refreshToken;
    if (!token) throw errores.noAutenticado('No existe una sesion que renovar.');

    const valido = await validarRefreshToken(token);
    const registro = await buscarUsuarioPorId(valido.id_usuario);

    if (!registro || !registro.activo) {
      await revocarToken(valido.id_token, 'USUARIO_INACTIVO');
      limpiarCookiesSesion(res);
      throw errores.noAutenticado('Su usuario ya no tiene acceso al sistema.');
    }

    await revocarToken(valido.id_token, 'ROTACION');
    const usuario = await construirUsuarioAutenticado(registro);
    const nuevo = await emitirRefreshToken(
      usuario.id_usuario,
      valido.familia,
      req.ip,
      req.get('user-agent'),
    );
    const csrf = establecerCookiesSesion(res, firmarTokenAcceso(usuario), nuevo.token);

    ok(res, { usuario, csrfToken: csrf, expiraEnMinutos: env.auth.accessTtlMin });
  }),
);

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[COOKIE_REFRESCO];
    if (token) {
      try {
        const valido = await validarRefreshToken(token);
        await revocarToken(valido.id_token, 'CIERRE_SESION');
        await registrarAuditoria({
          idUsuario: valido.id_usuario,
          accion: 'CIERRE_SESION',
          entidad: 'usuarios',
          idEntidad: valido.id_usuario,
          ip: req.ip,
          correlationId: req.correlationId,
        });
      } catch {
        // Un token invalido no impide cerrar la sesion del navegador.
      }
    }
    limpiarCookiesSesion(res);
    ok(res, { mensaje: 'Sesion finalizada correctamente.' });
  }),
);

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------
authRouter.get(
  '/me',
  requiereAutenticacion,
  asyncHandler(async (req, res) => {
    const registro = await buscarUsuarioPorId(req.usuario!.id_usuario);
    ok(res, {
      usuario: req.usuario,
      debeCambiarPassword: Boolean(registro?.debe_cambiar_password),
      ultimoAcceso: registro?.ultimo_acceso ?? null,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /auth/change-password
// ---------------------------------------------------------------------------
authRouter.post(
  '/change-password',
  requiereAutenticacion,
  validarCuerpo(esquemaCambioPassword),
  asyncHandler(async (req, res) => {
    const { passwordActual, passwordNueva } = req.body as z.infer<typeof esquemaCambioPassword>;
    const registro = await buscarUsuarioPorId(req.usuario!.id_usuario);
    if (!registro) throw errores.noAutenticado();

    const valida = await verificarPassword(passwordActual, registro.password_hash);
    if (!valida) {
      await auditarDesdeRequest(req, {
        accion: 'CAMBIO_PASSWORD',
        entidad: 'usuarios',
        idEntidad: registro.id_usuario,
        resultado: 'FALLO',
        motivo: 'Contraseña actual incorrecta',
      });
      throw errores.validacion('La contraseña actual no es correcta.');
    }

    if (passwordActual === passwordNueva) {
      throw errores.validacion('La nueva contraseña debe ser diferente de la actual.');
    }

    const problemas = validarFortalezaPassword(passwordNueva);
    if (problemas.length > 0) {
      throw errores.validacion('La nueva contraseña no cumple la politica de seguridad.', {
        requisitos: problemas,
      });
    }

    await execute(
      `UPDATE usuarios
          SET password_hash = ?, debe_cambiar_password = 0, password_actualizado_en = NOW()
        WHERE id_usuario = ?`,
      [await hashPassword(passwordNueva), registro.id_usuario],
    );

    // Se cierran las demas sesiones para invalidar credenciales anteriores.
    await revocarSesionesUsuario(registro.id_usuario, 'CAMBIO_PASSWORD');
    const usuario = await construirUsuarioAutenticado(registro);
    const nuevo = await emitirRefreshToken(usuario.id_usuario, null, req.ip, req.get('user-agent'));
    const csrf = establecerCookiesSesion(res, firmarTokenAcceso(usuario), nuevo.token);

    await auditarDesdeRequest(req, {
      accion: 'CAMBIO_PASSWORD',
      entidad: 'usuarios',
      idEntidad: registro.id_usuario,
    });

    ok(res, { mensaje: 'Contraseña actualizada correctamente.', csrfToken: csrf });
  }),
);

// ---------------------------------------------------------------------------
// GET /auth/sesiones  (sesiones activas del propio usuario)
// ---------------------------------------------------------------------------
authRouter.get(
  '/sesiones',
  requiereAutenticacion,
  asyncHandler(async (req, res) => {
    const fila = await queryOne<{ activas: number }>(
      `SELECT COUNT(*) AS activas FROM refresh_tokens
        WHERE id_usuario = ? AND revocado_en IS NULL AND expira_en > NOW()`,
      [req.usuario!.id_usuario],
    );
    ok(res, { sesionesActivas: fila?.activas ?? 0 });
  }),
);
