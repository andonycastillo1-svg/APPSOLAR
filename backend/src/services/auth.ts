import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '../config/env';
import { query, queryOne, execute } from '../db/pool';
import { errores } from '../utils/errors';
import type { Permiso, RolCodigo } from '../config/permisos';
import type { UsuarioAutenticado } from '../types/express';

export const COOKIE_ACCESO = 'as_acceso';
export const COOKIE_REFRESCO = 'as_refresco';
export const COOKIE_CSRF = 'as_csrf';

export interface UsuarioRegistro {
  id_usuario: number;
  nombre: string;
  email: string;
  password_hash: string;
  id_rol: number;
  rol: RolCodigo;
  activo: number;
  debe_cambiar_password: number;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
  ultimo_acceso: string | null;
  password_actualizado_en: string | null;
}

// ---------------------------------------------------------------------------
// Contrasenas
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.auth.bcryptRounds);
}

export async function verificarPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** Politica minima de contrasenas, con mensajes en espanol. */
export function validarFortalezaPassword(password: string): string[] {
  const problemas: string[] = [];
  if (password.length < 10) problemas.push('Debe tener al menos 10 caracteres.');
  if (!/[A-Z]/.test(password)) problemas.push('Debe incluir al menos una letra mayuscula.');
  if (!/[a-z]/.test(password)) problemas.push('Debe incluir al menos una letra minuscula.');
  if (!/[0-9]/.test(password)) problemas.push('Debe incluir al menos un numero.');
  if (!/[^A-Za-z0-9]/.test(password)) problemas.push('Debe incluir al menos un caracter especial.');
  return problemas;
}

/** Contrasena temporal segura para el restablecimiento administrativo. */
export function generarPasswordTemporal(): string {
  const mayus = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const minus = 'abcdefghijkmnopqrstuvwxyz';
  const digitos = '23456789';
  const especiales = '!@#$%&*?';
  const todos = mayus + minus + digitos + especiales;
  const pick = (fuente: string) => fuente[crypto.randomInt(fuente.length)];
  const base = [pick(mayus), pick(minus), pick(digitos), pick(especiales)];
  while (base.length < 14) base.push(pick(todos));
  for (let i = base.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join('');
}

// ---------------------------------------------------------------------------
// Permisos efectivos
// ---------------------------------------------------------------------------

/**
 * Permisos efectivos = permisos del rol + otorgados individuales - revocados.
 * Se resuelve siempre en el servidor: ocultar una opcion en la interfaz nunca
 * sustituye esta verificacion.
 */
export async function permisosEfectivos(idUsuario: number): Promise<Permiso[]> {
  const filas = await query<{ codigo: string; origen: string; otorgado: number }>(
    `SELECT p.codigo, 'ROL' AS origen, 1 AS otorgado
       FROM usuarios u
       JOIN rol_permisos rp ON rp.id_rol = u.id_rol
       JOIN permisos p ON p.id_permiso = rp.id_permiso
      WHERE u.id_usuario = ?
      UNION ALL
     SELECT p.codigo, 'USUARIO' AS origen, up.otorgado
       FROM usuario_permisos up
       JOIN permisos p ON p.id_permiso = up.id_permiso
      WHERE up.id_usuario = ?`,
    [idUsuario, idUsuario],
  );

  const efectivos = new Set<string>();
  for (const fila of filas.filter((f) => f.origen === 'ROL')) efectivos.add(fila.codigo);
  for (const fila of filas.filter((f) => f.origen === 'USUARIO')) {
    if (fila.otorgado) efectivos.add(fila.codigo);
    else efectivos.delete(fila.codigo);
  }
  return [...efectivos].sort() as Permiso[];
}

export async function buscarUsuarioPorEmail(email: string): Promise<UsuarioRegistro | null> {
  return queryOne<UsuarioRegistro>(
    `SELECT u.*, r.codigo AS rol
       FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol
      WHERE u.email = ?`,
    [email.trim().toLowerCase()],
  );
}

export async function buscarUsuarioPorId(id: number): Promise<UsuarioRegistro | null> {
  return queryOne<UsuarioRegistro>(
    `SELECT u.*, r.codigo AS rol
       FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol
      WHERE u.id_usuario = ?`,
    [id],
  );
}

export async function construirUsuarioAutenticado(
  registro: UsuarioRegistro,
): Promise<UsuarioAutenticado> {
  return {
    id_usuario: registro.id_usuario,
    nombre: registro.nombre,
    email: registro.email,
    rol: registro.rol,
    id_rol: registro.id_rol,
    permisos: await permisosEfectivos(registro.id_usuario),
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface PayloadAcceso {
  sub: number;
  email: string;
  rol: RolCodigo;
}

export function firmarTokenAcceso(usuario: UsuarioAutenticado): string {
  const payload: PayloadAcceso = {
    sub: usuario.id_usuario,
    email: usuario.email,
    rol: usuario.rol,
  };
  return jwt.sign(payload, env.auth.accessSecret, {
    expiresIn: `${env.auth.accessTtlMin}m`,
    issuer: 'appsolar',
  });
}

export function verificarTokenAcceso(token: string): PayloadAcceso {
  try {
    return jwt.verify(token, env.auth.accessSecret, { issuer: 'appsolar' }) as unknown as PayloadAcceso;
  } catch {
    throw errores.noAutenticado();
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface RefrescoEmitido {
  token: string;
  familia: string;
  expiraEn: Date;
}

export async function emitirRefreshToken(
  idUsuario: number,
  familia: string | null,
  ip?: string | null,
  userAgent?: string | null,
): Promise<RefrescoEmitido> {
  const token = crypto.randomBytes(48).toString('hex');
  const grupo = familia ?? crypto.randomUUID();
  const expiraEn = new Date(Date.now() + env.auth.refreshTtlDays * 86400000);

  // La expiracion se calcula con el reloj de MySQL para que todas las
  // comparaciones posteriores (`expira_en > NOW()`) usen la misma referencia.
  await execute(
    `INSERT INTO refresh_tokens (id_usuario, token_hash, familia, expira_en, ip, user_agent)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)`,
    [
      idUsuario,
      hashToken(token),
      grupo,
      env.auth.refreshTtlDays,
      ip ?? null,
      userAgent ? String(userAgent).slice(0, 255) : null,
    ],
  );

  return { token, familia: grupo, expiraEn };
}

export interface RefrescoValido {
  id_token: number;
  id_usuario: number;
  familia: string;
}

export async function validarRefreshToken(token: string): Promise<RefrescoValido> {
  const fila = await queryOne<{
    id_token: number;
    id_usuario: number;
    familia: string;
    revocado_en: string | null;
    expirado: number;
  }>(
    `SELECT id_token, id_usuario, familia, revocado_en,
            (expira_en <= NOW()) AS expirado
       FROM refresh_tokens WHERE token_hash = ?`,
    [hashToken(token)],
  );

  if (!fila) throw errores.noAutenticado();

  if (fila.revocado_en) {
    // Reuso de un token revocado: se invalida toda la familia por seguridad.
    await execute(
      `UPDATE refresh_tokens
          SET revocado_en = NOW(), motivo_revocacion = 'REUSO_DETECTADO'
        WHERE familia = ? AND revocado_en IS NULL`,
      [fila.familia],
    );
    throw errores.noAutenticado('Se detecto un reuso de sesion. Inicie sesion nuevamente.');
  }

  if (fila.expirado) {
    throw errores.noAutenticado('Su sesion expiro. Inicie sesion nuevamente.');
  }

  return { id_token: fila.id_token, id_usuario: fila.id_usuario, familia: fila.familia };
}

export async function revocarToken(idToken: number, motivo: string): Promise<void> {
  await execute(
    'UPDATE refresh_tokens SET revocado_en = NOW(), motivo_revocacion = ? WHERE id_token = ?',
    [motivo, idToken],
  );
}

/** Revoca todas las sesiones de un usuario (logout global o desactivacion). */
export async function revocarSesionesUsuario(idUsuario: number, motivo: string): Promise<number> {
  const resultado = await execute(
    `UPDATE refresh_tokens SET revocado_en = NOW(), motivo_revocacion = ?
      WHERE id_usuario = ? AND revocado_en IS NULL`,
    [motivo, idUsuario],
  );
  return resultado.affectedRows;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function opcionesBase() {
  return {
    httpOnly: true as const,
    secure: env.auth.cookieSecure,
    sameSite: env.auth.cookieSameSite,
    domain: env.auth.cookieDomain,
    path: '/',
  };
}

export function establecerCookiesSesion(
  res: Response,
  tokenAcceso: string,
  tokenRefresco: string,
): string {
  const csrf = crypto.randomBytes(24).toString('hex');

  res.cookie(COOKIE_ACCESO, tokenAcceso, {
    ...opcionesBase(),
    maxAge: env.auth.accessTtlMin * 60 * 1000,
  });
  res.cookie(COOKIE_REFRESCO, tokenRefresco, {
    ...opcionesBase(),
    maxAge: env.auth.refreshTtlDays * 86400 * 1000,
  });
  // El token CSRF debe ser legible por el frontend (patron double submit).
  res.cookie(COOKIE_CSRF, csrf, {
    ...opcionesBase(),
    httpOnly: false,
    maxAge: env.auth.refreshTtlDays * 86400 * 1000,
  });

  return csrf;
}

export function limpiarCookiesSesion(res: Response): void {
  const opciones = { ...opcionesBase() };
  res.clearCookie(COOKIE_ACCESO, opciones);
  res.clearCookie(COOKIE_REFRESCO, opciones);
  res.clearCookie(COOKIE_CSRF, { ...opciones, httpOnly: false });
}
