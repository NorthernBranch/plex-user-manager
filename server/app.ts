import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { resolve } from 'node:path';
import { Auth } from './auth.js';
import { Access } from './access.js';
import { Plex, type PlexAdapter, type SelectedServer } from './plex.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { AppError, safeError } from './errors.js';
import { EmailQueue } from './email.js';
import { Monitor } from './monitor.js';
import { registerIntegrationRoutes } from './routes/integration.js';
import { registerAccessRoutes } from './routes/access.js';
import { registerMonitoringRoutes } from './routes/monitoring.js';
import { registerCommunicationRoutes, registerRecipientRoutes } from './routes/communications.js';
import { Contacts } from './contacts.js';
import { Communications } from './communications.js';

export function createApp(store: Store, config: Config, injected?: PlexAdapter) {
  const app = express(),
    auth = new Auth(store, config),
    email = new EmailQueue(store),
    monitor = new Monitor(store);
  app.disable('x-powered-by');
  app.set('trust proxy', config.proxy.length ? config.proxy : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.secure ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '64kb' }), cookieParser());
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(
    '/api',
    (_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
    auth.origin.bind(auth),
  );
  app.get('/api/setup/status', (_req, res) => res.json({ initialized: auth.initialized() }));
  app.post('/api/setup', auth.rateLimit.bind(auth), (req, res) =>
    res.json(auth.setup(req.body, res)),
  );
  app.post('/api/login', auth.rateLimit.bind(auth), (req, res) =>
    res.json(auth.login(req.body, res)),
  );
  const recipientRouter = express.Router();
  app.use('/api/recipient', recipientRouter);
  app.use('/api', auth.session.bind(auth));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      store.audit('request.start', `${req.method} ${req.path}`, 'authorised');
      res.once('finish', () => {
        try {
          store.audit('request.result', `${req.method} ${req.path}`, `HTTP ${res.statusCode}`);
        } catch {
          /* A storage failure is reported by the operation itself. */
        }
      });
    }
    next();
  });
  const client = () => {
    if (injected) return injected;
    const credential = store.getSecret<{ token: string; clientId: string }>('plex');
    if (!credential) throw new AppError(409, 'PLEX_SETUP', 'Connect a Plex owner account first.');
    return new Plex(credential.token, credential.clientId);
  };
  const selected = () => {
    const value = store.getSecret<SelectedServer>('server');
    if (!value) throw new AppError(409, 'SERVER_SETUP', 'Select and test an owned server first.');
    return value;
  };
  const access = new Access(store, client, () => selected().id);
  store.set('publicUrl', config.url);
  const contacts = new Contacts(store, email, config.url, client, () => selected().id);
  const communications = new Communications(store, email, client, selected);
  email.setGuard((row, now) => communications.deliveryGuard(row, now));
  registerRecipientRoutes(recipientRouter, contacts);
  app.get('/api/session', (_req, res) => res.json({ csrf: res.locals.csrf }));
  app.post('/api/logout', (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });
  app.post('/api/password', auth.rateLimit.bind(auth), (req, res) => {
    auth.password(req.body);
    auth.logout(req, res);
    res.json({ ok: true });
  });
  const services = {
    app,
    store,
    config,
    client,
    selected,
    access,
    monitor,
    email,
    contacts,
    communications,
  };
  registerIntegrationRoutes(services);
  registerAccessRoutes(services);
  registerMonitoringRoutes(services);
  registerCommunicationRoutes(services);
  app.use('/api', (_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'API route not found.')),
  );
  app.use(
    express.static(resolve('dist/web'), {
      index: false,
      setHeaders: (res, path) => {
        if (path.endsWith('sw.js') || path.endsWith('index.html'))
          res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/web/index.html')));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ZodError)
        return res.status(400).json({
          code: 'VALIDATION',
          error: 'Invalid input. Check required fields, ranges and formats.',
        });
      res.status(error instanceof AppError ? error.status : 500).json({
        code: error instanceof AppError ? error.code : 'INTERNAL',
        error: safeError(error),
      });
    },
  );
  return { app, access, monitor, email, client, selected, contacts, communications };
}
