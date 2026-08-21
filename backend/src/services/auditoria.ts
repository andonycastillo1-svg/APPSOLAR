import type { Request } from 'express';
import { execute, type Executor, getPool } from '../db/pool';
import { logger } from '../config/logger';

export interface EntradaAuditoria {
  idUsuario?: number | null;
  usuarioEmail?: string | null;
  accion: string;
  entidad: string;
  idEntidad?: string | number | null;
  resultado?: 'EXITO' | 'FALLO';
  antes?: unknown;
  despues?: unknown;
  motivo?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/** Campos que nunca deben quedar registrados en la auditoria. */
const CAMPOS_SENSIBLES = new Set([
  'password',
  'password_hash',
  'passwordActual',
  'passwordNueva',
  'contrasena',
  'token',
  'token_hash',
  'accessToken',
  'refreshToken',
  'systemCode',
  'secreto',
  'secret',
]);

export function sanitizar(valor: unknown): unknown {
  if (valor === null || valor === undefined) return null;
  if (Array.isArray(valor)) return valor.map(sanitizar);
  if (typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const [clave, contenido] of Object.entries(valor as Record<string, unknown>)) {
      salida[clave] = CAMPOS_SENSIBLES.has(clave) ? '[REDACTADO]' : sanitizar(contenido);
    }
    return salida;
  }
  return valor;
}

/**
 * Registra una accion relevante. Nunca interrumpe la operacion principal:
 * si la escritura falla se registra en el log y se continua.
 */
export async function registrarAuditoria(
  entrada: EntradaAuditoria,
  executor: Executor = getPool(),
): Promise<void> {
  try {
    await execute(
      `INSERT INTO auditoria
         (id_usuario, usuario_email, accion, entidad, id_entidad, resultado,
          datos_antes, datos_despues, motivo, ip, user_agent, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entrada.idUsuario ?? null,
        entrada.usuarioEmail ?? null,
        entrada.accion,
        entrada.entidad,
        entrada.idEntidad !== undefined && entrada.idEntidad !== null
          ? String(entrada.idEntidad)
          : null,
        entrada.resultado ?? 'EXITO',
        entrada.antes === undefined ? null : JSON.stringify(sanitizar(entrada.antes)),
        entrada.despues === undefined ? null : JSON.stringify(sanitizar(entrada.despues)),
        entrada.motivo ?? null,
        entrada.ip ?? null,
        entrada.userAgent ? String(entrada.userAgent).slice(0, 255) : null,
        entrada.correlationId ?? null,
      ],
      executor,
    );
  } catch (error) {
    logger.error({ err: error, accion: entrada.accion }, 'No se pudo registrar la auditoria');
  }
}

/** Atajo que toma usuario, IP y correlacion desde la peticion HTTP. */
export async function auditarDesdeRequest(
  req: Request,
  entrada: Omit<EntradaAuditoria, 'idUsuario' | 'usuarioEmail' | 'ip' | 'userAgent' | 'correlationId'>,
  executor?: Executor,
): Promise<void> {
  await registrarAuditoria(
    {
      ...entrada,
      idUsuario: req.usuario?.id_usuario ?? null,
      usuarioEmail: req.usuario?.email ?? null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      correlationId: req.correlationId ?? null,
    },
    executor,
  );
}
