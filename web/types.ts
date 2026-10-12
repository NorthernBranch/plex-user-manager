export type Library = { id: string; title: string; type: string };
export type User = {
  id: string;
  name: string;
  kind: 'shared' | 'pending' | 'managed';
  shareId: string;
  libraries: string[];
  notes: string;
  filters: Record<string, string>;
  expiry: { due: number; status: string; error: string | null } | null;
  contact?: import('../server/recipients').Contact | null;
};
export type Snapshot = {
  server: string;
  users: User[];
  libraries: Library[];
  capabilities: { plexPass: boolean; restrictionScope: string };
};
export type Settings = {
  publicUrl: string;
  plexConnected: boolean;
  server: { id: string; name: string; url: string } | null;
  monitor: MonitorSettings;
  smtp: (SmtpSettings & { hasPassword: boolean }) | null;
  heartbeat: { url: string; key: string; hasKey: boolean } | null;
  heartbeatDelivery: {
    at: number;
    ok: boolean;
    configurationAuthenticated?: boolean;
    stale?: boolean;
    maintenanceMatch?: boolean | null;
    recipientsMatch?: boolean | null;
  } | null;
};
export type Health = {
  state: { state: string; unknown: boolean; last?: number; lastOk?: boolean };
  incidents: Incident[];
  timeline: { id: number; at: number; incident: string | null; event: string }[];
  expiries: {
    server: string;
    user: string;
    due: number;
    status: string;
    attempts: number;
    error: string | null;
  }[];
};
export type Notice = (message: string) => void;
import type { MonitorSettings, SmtpSettings } from '../server/config.js';
import type { Incident } from '../server/monitor.js';
export type OwnedServerPublic = { id: string; name: string; connections: string[] };
export type Preset = { id: string; name: string; libraries: string[] };
export type BulkPreview = {
  ticket: string;
  plan: { id: string; name: string; shareId: string; before: string[]; after: string[] }[];
};
export type BulkResult = { id: string; ok: boolean; error?: string };
export type AuditEntry = { id: number; at: number; action: string; target: string; result: string };
export type DeliverySummary = {
  id: number;
  incident: string;
  kind: string;
  recipient: string;
  status: string;
  attempts: number;
  error: string | null;
  sent: number | null;
  next: number;
};
