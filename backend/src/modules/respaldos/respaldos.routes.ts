import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { env } from '../../config/env';
import { PERMISOS } from '../../config/permisos';
import { requiereAutenticacion, requierePermiso } from '../../middleware/autenticacion';
import { auditarDesdeRequest } from '../../services/auditoria';
import { generarRespaldo, restaurarRespaldo } from '../../services/respaldos';
import { errores } from '../../utils/errors';
import { asyncHandler, ok } from '../../utils/http';

export const respaldosRouter = Router();
respaldosRouter.use(requiereAutenticacion, requierePermiso(PERMISOS.CONFIG_GESTIONAR));

const subidor = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploads.maxBackupMb * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.json') {
      cb(errores.validacion('El respaldo debe ser un archivo .json generado por este sistema.'));
      return;
    }
    cb(null, true);
  },
});

function nombreArchivo(): string {
  const ahora = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const marca = `${ahora.getFullYear()}${p(ahora.getMonth() + 1)}${p(ahora.getDate())}_${p(ahora.getHours())}${p(ahora.getMinutes())}`;
  return `appsolar_respaldo_${marca}.json`;
}

// ---------------------------------------------------------------------------
// GET /config/backup/download  -> descarga una copia completa de los datos
// ---------------------------------------------------------------------------
respaldosRouter.get(
  '/download',
  asyncHandler(async (req, res) => {
    const respaldo = await generarRespaldo();
    const filas = Object.values(respaldo.tablas).reduce((total, t) => total + t.filas.length, 0);

    await auditarDesdeRequest(req, {
      accion: 'RESPALDO_DESCARGADO',
      entidad: 'sistema',
      despues: { tablas: Object.keys(respaldo.tablas).length, filas },
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo()}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(respaldo));
  }),
);

// ---------------------------------------------------------------------------
// POST /config/backup/restore  -> reemplaza TODOS los datos con los del archivo
// ---------------------------------------------------------------------------
respaldosRouter.post(
  '/restore',
  subidor.single('archivo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw errores.solicitudInvalida('Debe adjuntar el archivo de respaldo.');
    if (req.body?.confirmacion !== 'RESTAURAR') {
      throw errores.solicitudInvalida('Debe escribir RESTAURAR para confirmar la operacion.');
    }

    let datos: unknown;
    try {
      datos = JSON.parse(req.file.buffer.toString('utf8'));
    } catch {
      throw errores.validacion('El archivo no es un JSON valido o esta dañado.');
    }

    const resultado = await restaurarRespaldo(datos);

    // Se registra despues de restaurar para que quede constancia en la bitacora vigente.
    await auditarDesdeRequest(req, {
      accion: 'RESPALDO_RESTAURADO',
      entidad: 'sistema',
      despues: { ...resultado, archivo: path.basename(req.file.originalname).slice(0, 120) },
    });

    ok(res, {
      ...resultado,
      mensaje:
        `Respaldo restaurado: ${resultado.filas} registros en ${resultado.tablas} tablas. ` +
        'Por seguridad, vuelva a iniciar sesion.',
    });
  }),
);
