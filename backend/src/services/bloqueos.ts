import { execute, queryOne } from '../db/pool';
import { errores } from '../utils/errors';

/**
 * Bloqueo cooperativo con expiracion, para impedir sincronizaciones o
 * importaciones concurrentes sobre el mismo recurso.
 */
export async function adquirirBloqueo(
  recurso: string,
  idUsuario: number | null,
  segundos: number,
  detalle?: string,
): Promise<void> {
  // Se limpia primero cualquier bloqueo vencido del mismo recurso.
  await execute('DELETE FROM bloqueos WHERE recurso = ? AND expira_en <= NOW()', [recurso]);

  try {
    await execute(
      `INSERT INTO bloqueos (recurso, id_usuario, detalle, expira_en)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [recurso, idUsuario, detalle ?? null, segundos],
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
      const actual = await queryOne<{ detalle: string | null; expira_en: string }>(
        'SELECT detalle, expira_en FROM bloqueos WHERE recurso = ?',
        [recurso],
      );
      throw errores.conflicto(
        'Ya hay una operacion en curso sobre este recurso. Espere a que termine e intente de nuevo.',
        { recurso, detalle: actual?.detalle, expiraEn: actual?.expira_en },
      );
    }
    throw error;
  }
}

export async function liberarBloqueo(recurso: string): Promise<void> {
  await execute('DELETE FROM bloqueos WHERE recurso = ?', [recurso]);
}

/** Ejecuta una operacion protegida por bloqueo, liberandolo siempre al final. */
export async function conBloqueo<T>(
  recurso: string,
  idUsuario: number | null,
  segundos: number,
  detalle: string,
  fn: () => Promise<T>,
): Promise<T> {
  await adquirirBloqueo(recurso, idUsuario, segundos, detalle);
  try {
    return await fn();
  } finally {
    await liberarBloqueo(recurso);
  }
}
