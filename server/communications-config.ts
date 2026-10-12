import { z } from 'zod';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

export { categories, noPreferences } from './communication-preferences.js';
export type { Category, Preferences } from './communication-preferences.js';
export const preferencesSchema = z.object({
  outage: z.boolean(),
  recovery: z.boolean(),
  maintenance: z.boolean(),
  announcement: z.boolean(),
  welcome: z.boolean(),
  expiry: z.boolean(),
});
export const subjectSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/, 'Subject must not contain line breaks.');
export const bodySchema = z.string().min(1).max(10000);
export const publicLink = z
  .string()
  .max(1000)
  .refine((value) => {
    if (!value) return true;
    try {
      const u = new URL(value);
      const hostname = u.hostname.replace(/^\[|\]$/g, '');
      return (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        !isIP(hostname) &&
        hostname.includes('.') &&
        !/\.(local|internal|lan|home|localhost)$/i.test(hostname)
      );
    } catch {
      return false;
    }
  }, 'Use a public HTTPS link without credentials, query parameters or fragments.');
const leads = z
  .array(z.number().int().min(60).max(2592000))
  .max(10)
  .refine((items) => new Set(items).size === items.length, 'Lead times must be unique.');
export const communicationsSettingsSchema = z.object({
  batchSize: z.number().int().min(1).max(20),
  welcome: z.object({
    enabled: z.boolean(),
    subject: subjectSchema,
    body: bodySchema,
    gettingStarted: z.string().max(3000),
    rules: z.string().max(3000),
    requestUrl: publicLink,
    supportUrl: publicLink,
  }),
  expiry: z.object({
    enabled: z.boolean(),
    leads,
    user: z.boolean(),
    administrators: z.array(z.email()).max(30),
    subject: subjectSchema,
    body: bodySchema,
    renewalUrl: publicLink,
    instructions: z.string().max(3000),
  }),
  maintenance: z.object({ subject: subjectSchema, body: bodySchema }),
});
export type CommunicationsSettings = z.infer<typeof communicationsSettingsSchema>;
export const defaultCommunications: CommunicationsSettings = {
  batchSize: 5,
  welcome: {
    enabled: false,
    subject: 'Welcome to {{server}}',
    body: 'Welcome to {{server}}.\nLibraries: {{libraries}}\n{{gettingStarted}}\n{{rules}}\nRequests: {{requestUrl}}\nSupport: {{supportUrl}}',
    gettingStarted: '',
    rules: '',
    requestUrl: '',
    supportUrl: '',
  },
  expiry: {
    enabled: false,
    leads: [604800, 86400],
    user: true,
    administrators: [],
    subject: 'Scheduled access expiry for {{server}}',
    body: 'Access is scheduled to expire at {{expires}} (UTC) on {{server}}. This is a reminder, not confirmation of revocation.\n{{instructions}}\nRenewal information: {{renewalUrl}}\nOpening a link does not renew access.',
    renewalUrl: '',
    instructions: '',
  },
  maintenance: {
    subject: '{{title}} — maintenance {{change}}',
    body: '{{explanation}}\nServer: {{server}}\nStarts: {{start}} (UTC)\nExpected end: {{end}} (UTC)\nStatus: {{change}}. Expected end does not prove service recovery.',
  },
};
export const welcomeVariables = [
  'server',
  'libraries',
  'gettingStarted',
  'rules',
  'requestUrl',
  'supportUrl',
];
export const expiryVariables = ['server', 'expires', 'instructions', 'renewalUrl'];
export const maintenanceVariables = ['title', 'explanation', 'server', 'start', 'end', 'change'];
export function renderTemplate(template: string, values: Record<string, string>) {
  const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key))
      throw new AppError(
        400,
        'TEMPLATE',
        'Unsupported or missing template variable. Use the variables listed for this template.',
      );
    return values[key];
  });
  if (rendered.includes('{{') || rendered.includes('}}'))
    throw new AppError(400, 'TEMPLATE', 'Template braces are incomplete.');
  return rendered;
}
export function validateTemplates(settings: CommunicationsSettings) {
  for (const [template, allowed] of [
    [settings.welcome, welcomeVariables],
    [settings.expiry, expiryVariables],
    [settings.maintenance, maintenanceVariables],
  ] as const) {
    const values = Object.fromEntries(allowed.map((key) => [key, 'Sample']));
    subjectSchema.parse(renderTemplate(template.subject, values));
    renderTemplate(template.body, values);
  }
}
