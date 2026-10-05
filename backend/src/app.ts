import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import path from 'node:path';
import fs from 'node:fs';

import { env } from './config/env';
import { logger } from './config/logger';
import { correlacion, protegerCsrf } from './middleware/autenticacion';
import { manejadorErrores, noEncontrado } from './middleware/errores';
import { ok } from './utils/http';

import { authRouter } from './modules/auth/auth.routes';
import { usuariosRouter } from './modules/usuarios/usuarios.routes';
import { clientesRouter } from './modules/clientes/clientes.routes';
import { proyectosRouter } from './modules/proyectos/proyectos.routes';
import { inversoresRouter } from './modules/inversores/inversores.routes';
import { produccionRouter } from './modules/produccion/produccion.routes';
import { importacionesRouter } from './modules/importaciones/importaciones.routes';
import { huaweiRouter } from './modules/integracion/huawei.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { reportesRouter } from './modules/reportes/reportes.routes';
import { auditoriaRouter, configuracionRouter, saludRouter } from './modules/sistema/sistema.routes';
import { respaldosRouter } from './modules/respaldos/respaldos.routes';

export function crearApp() {
  const app = express();

  if (env.trustProxy) app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  // --- Seguridad de cabeceras -----------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", ...env.corsOrigins],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: env.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );

  // --- CORS limitado a los origenes autorizados ------------------------
  //
  // Un origen no autorizado NO recibe cabeceras CORS (el navegador bloquea la
  // lectura de la respuesta), pero la peticion no se convierte en un error 500:
  // eso romperia el servicio de archivos estaticos del propio frontend.
  const origenesPermitidos = new Set([env.publicUrl, ...env.corsOrigins]);

  app.use(
    cors((req, callback) => {
      const origen = req.headers.origin;
      const propio = `${req.protocol}://${req.headers.host ?? ''}`;
      const permitido =
        !origen || origen === propio || origenesPermitidos.has(origen);

      if (!permitido) {
        logger.warn({ origen, ruta: req.url }, 'Peticion con origen no autorizado');
      }

      callback(null, {
        origin: permitido,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-correlation-id'],
        maxAge: 600,
      });
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(cookieParser());
  app.use(correlacion);

  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as { correlationId?: string }).correlationId ?? '',
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // La redaccion de secretos se define en el logger.
        serializers: {
          req: (req) => ({ metodo: req.method, ruta: req.url }),
          res: (res) => ({ estado: res.statusCode }),
        },
      }),
    );
  }

  // --- Limitador general ------------------------------------------------
  app.use(
    env.apiPrefix,
    rateLimit({
      windowMs: env.auth.rateLimitWindowMin * 60 * 1000,
      limit: env.isTest ? 100000 : env.auth.rateLimitMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        ok: false,
        error: {
          codigo: 'LIMITE_SOLICITUDES',
          mensaje: 'Se alcanzo el limite de solicitudes. Espere unos minutos e intente de nuevo.',
        },
      },
    }),
  );

  // El CDN del hosting no debe guardar respuestas de la API: datos y sesiones son por usuario.
  app.use(env.apiPrefix, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(protegerCsrf);

  // --- Rutas ------------------------------------------------------------
  app.use('/health', saludRouter);
  app.use(`${env.apiPrefix}/health`, saludRouter);
  app.use(`${env.apiPrefix}/auth`, authRouter);
  app.use(`${env.apiPrefix}/users`, usuariosRouter);
  app.use(`${env.apiPrefix}/clients`, clientesRouter);
  app.use(`${env.apiPrefix}/projects`, proyectosRouter);
  app.use(`${env.apiPrefix}/inverters`, inversoresRouter);
  app.use(`${env.apiPrefix}/production`, produccionRouter);
  app.use(`${env.apiPrefix}/imports`, importacionesRouter);
  app.use(`${env.apiPrefix}/integrations/huawei`, huaweiRouter);
  app.use(`${env.apiPrefix}/dashboard`, dashboardRouter);
  app.use(`${env.apiPrefix}/reports`, reportesRouter);
  app.use(`${env.apiPrefix}/audit`, auditoriaRouter);
  app.use(`${env.apiPrefix}/config/backup`, respaldosRouter);
  app.use(`${env.apiPrefix}/config`, configuracionRouter);

  // Documentacion OpenAPI (servida como archivo estatico del repositorio).
  app.get(`${env.apiPrefix}/openapi.json`, (_req, res) => {
    const ruta = path.join(env.paths.root, 'docs', 'openapi.json');
    if (!fs.existsSync(ruta)) {
      res.status(404).json({ ok: false, error: { codigo: 'NO_ENCONTRADO', mensaje: 'Especificacion no disponible.' } });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(fs.readFileSync(ruta, 'utf8'));
  });

  app.get(`${env.apiPrefix}`, (_req, res) => {
    ok(res, {
      servicio: env.appName,
      version: '1.0.0',
      documentacion: `${env.apiPrefix}/openapi.json`,
      zonaHoraria: env.timezone,
      moneda: 'GTQ',
    });
  });

  // --- Frontend compilado (despliegue de un solo servicio) --------------
  const distFrontend = path.join(env.paths.root, 'frontend', 'dist');
  if (fs.existsSync(distFrontend)) {
    app.use(express.static(distFrontend, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api)(?!\/health).*/, (_req, res) => {
      res.sendFile(path.join(distFrontend, 'index.html'));
    });
  }

  app.use(noEncontrado);
  app.use(manejadorErrores);

  return app;
}
