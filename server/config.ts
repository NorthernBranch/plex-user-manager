import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

export function secret(env: NodeJS.ProcessEnv, name: string): string {
  if (env[name] && env[`${name}_FILE`])
    throw new AppError(500, 'CONFIG', `Choose ${name} or its file variant, not both.`);
  try {
    return (
      env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8') : (env[name] ?? '')
    ).trim();
  } catch {
    throw new AppError(500, 'CONFIG', `Cannot read ${name} secret file.`);
  }
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const key = secret(env, 'ENCRYPTION_KEY');
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new AppError(
      500,
      'CONFIG',
      'ENCRYPTION_KEY must be a randomly generated 32-byte hex key.',
    );
  const bootstrap = secret(env, 'BOOTSTRAP_SECRET');
  if (bootstrap.length < 32)
    throw new AppError(500, 'CONFIG', 'BOOTSTRAP_SECRET must contain at least 32 characters.');
  const url = z.url().parse(env.PUBLIC_URL ?? 'http://localhost:3000');
  const u = new URL(url);
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/'
  )
    throw new AppError(500, 'CONFIG', 'PUBLIC_URL must be an HTTP(S) origin.');
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    throw new AppError(500, 'CONFIG', 'Public installations require HTTPS in PUBLIC_URL.');
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(env.PORT ?? 3000);
  const proxy = (env.TRUSTED_PROXY ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    proxy.some((x) => {
      const parts = x.split('/'),
        family = isIP(parts[0]);
      if (!family || parts.length > 2) return true;
      if (parts.length === 1) return false;
      const prefix = Number(parts[1]);
      return (
        !/^\d+$/.test(parts[1]) ||
        prefix < (family === 4 ? 24 : 64) ||
        prefix > (family === 4 ? 32 : 128)
      );
    })
  )
    throw new AppError(
      500,
      'CONFIG',
      'TRUSTED_PROXY must list IP addresses or narrow CIDRs (IPv4 /24 or narrower, IPv6 /64 or narrower).',
    );
  return {
    key,
    bootstrap,
    url: u.origin,
    secure: u.protocol === 'https:',
    port,
    proxy,
    dataDir: env.DATA_DIR ?? './data',
  };
}
export type Config = ReturnType<typeof loadConfig>;

export const recipientSchema = z.object({
  email: z.email().max(254),
  outage: z.boolean(),
  recovery: z.boolean(),
});
export const monitorSchema = z
  .object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(5).max(3600),
    timeoutSeconds: z.number().int().min(1).max(60),
    failureSeconds: z.number().int().min(5).max(86400),
    recoveryCount: z.number().int().min(1).max(20),
    recipients: z
      .array(recipientSchema)
      .max(100)
      .refine(
        (v) => new Set(v.map((r) => r.email.toLowerCase())).size === v.length,
        'Recipients must be unique.',
      ),
    maintenance: z
      .array(
        z
          .object({ start: z.iso.datetime(), end: z.iso.datetime() })
          .refine((v) => v.end > v.start, 'End must follow start.'),
      )
      .max(50),
    outageSubject: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    outageBody: z.string().min(1).max(10000),
    recoverySubject: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    recoveryBody: z.string().min(1).max(10000),
    authority: z.enum(['local', 'external']),
  })
  .refine(
    (v) => v.timeoutSeconds < v.intervalSeconds && v.failureSeconds >= v.intervalSeconds,
    'Timeout must be shorter than interval; failure duration must be at least one interval.',
  );
export type MonitorSettings = z.infer<typeof monitorSchema>;
export const defaultMonitor: MonitorSettings = {
  enabled: true,
  intervalSeconds: 30,
  timeoutSeconds: 10,
  failureSeconds: 300,
  recoveryCount: 2,
  recipients: [],
  maintenance: [],
  authority: 'local',
  outageSubject: 'Plex availability outage',
  outageBody: 'Incident {{incident}}: checks failed. Started {{started}}. Scope: {{scope}}.',
  recoverySubject: 'Plex availability recovered',
  recoveryBody:
    'Incident {{incident}} recovered at {{recovered}}. Observed downtime: {{downtime}}. Unobserved gaps are excluded. Scope: {{scope}}.',
};
export const smtpSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z\d.:-]+$/i),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['implicit', 'starttls']),
  username: z.string().max(500),
  password: z.string().max(2000),
  from: z.email(),
});
export type SmtpSettings = z.infer<typeof smtpSchema>;
export const heartbeatSchema = z.object({
  url: z.url().refine((x) => {
    const u = new URL(x);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
  }),
  key: z.string().min(32).max(512),
});
