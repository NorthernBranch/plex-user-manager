import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { type Config } from './config.js';
import { equal, hash, passwordHash, passwordVerify } from './crypto.js';
import { AppError } from './errors.js';
import { Store } from './store.js';

const credentials = z.object({
  username: z.string().min(3).max(80),
  password: z.string().min(12).max(256),
});
export class Auth {
  private failures = new Map<string, { count: number; until: number }>();
  private dummy = passwordHash(randomBytes(32).toString('hex'));
  constructor(
    private store: Store,
    private config: Config,
  ) {}
  initialized() {
    return !!this.store.one('SELECT id FROM admin WHERE id=1');
  }
  rateLimit(req: Request, _res: Response, next: NextFunction) {
    const now = Date.now(),
      key = req.ip ?? 'unknown';
    for (const [ip, entry] of this.failures) if (entry.until < now) this.failures.delete(ip);
    if (this.failures.size > 10000)
      return next(new AppError(429, 'RATE_LIMIT', 'Too many authentication attempts.'));
    const entry = this.failures.get(key) ?? { count: 0, until: now + 900000 };
    entry.count++;
    this.failures.set(key, entry);
    if (entry.count > 10)
      return next(
        new AppError(429, 'RATE_LIMIT', 'Too many attempts. Try again after 15 minutes.'),
      );
    next();
  }
  origin(req: Request, _res: Response, next: NextFunction) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== this.config.url)
      return next(new AppError(403, 'ORIGIN', 'Request origin is not allowed.'));
    next();
  }
  session(req: Request, res: Response, next: NextFunction) {
    const session = this.store.one<{ csrf: string; expires: number }>(
      'SELECT csrf,expires FROM sessions WHERE id=?',
      hash(req.cookies?.session ?? ''),
    );
    if (!session || session.expires <= Date.now())
      return next(new AppError(401, 'AUTH', 'Administrator login required.'));
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !equal(req.get('x-csrf-token') ?? '', session.csrf)
    )
      return next(new AppError(403, 'CSRF', 'Session verification failed. Reload and try again.'));
    res.locals.csrf = session.csrf;
    next();
  }
  private createSession(res: Response) {
    const token = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex'),
      expires = Date.now() + 8 * 3600000;
    this.store.run('DELETE FROM sessions WHERE expires<=?', Date.now());
    this.store.run('INSERT INTO sessions VALUES(?,?,?)', hash(token), csrf, expires);
    res.cookie('session', token, {
      httpOnly: true,
      secure: this.config.secure,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 3600000,
    });
    return { csrf, expires };
  }
  setup(body: unknown, res: Response) {
    const input = credentials.extend({ bootstrap: z.string().max(512) }).parse(body);
    if (!equal(input.bootstrap, this.config.bootstrap))
      throw new AppError(403, 'BOOTSTRAP', 'Bootstrap secret is invalid.');
    this.store.transaction(() => {
      if (this.initialized())
        throw new AppError(409, 'SETUP', 'Application administrator is already established.');
      this.store.run(
        'INSERT INTO admin VALUES(1,?,?)',
        input.username,
        passwordHash(input.password),
      );
      this.store.audit('setup', 'application', 'administrator established');
    });
    return this.createSession(res);
  }
  login(body: unknown, res: Response) {
    const input = credentials.parse(body);
    const admin = this.store.one<{ username: string; password: string }>(
      'SELECT * FROM admin WHERE id=1',
    );
    const valid = passwordVerify(input.password, admin?.password ?? this.dummy);
    if (!admin || !equal(input.username, admin.username) || !valid)
      throw new AppError(401, 'LOGIN', 'Invalid administrator credentials.');
    return this.createSession(res);
  }
  logout(req: Request, res: Response) {
    this.store.run('DELETE FROM sessions WHERE id=?', hash(req.cookies?.session ?? ''));
    res.clearCookie('session', {
      httpOnly: true,
      secure: this.config.secure,
      sameSite: 'strict',
      path: '/',
    });
  }
  password(body: unknown) {
    const input = z
        .object({ current: z.string().max(256), password: z.string().min(12).max(256) })
        .parse(body),
      admin = this.store.one<{ password: string }>('SELECT password FROM admin WHERE id=1')!;
    if (!passwordVerify(input.current, admin.password))
      throw new AppError(403, 'PASSWORD', 'Current password is invalid.');
    this.store.transaction(() => {
      this.store.run('UPDATE admin SET password=? WHERE id=1', passwordHash(input.password));
      this.store.run('DELETE FROM sessions');
      this.store.audit('password.change', 'application', 'sessions revoked');
    });
  }
}
