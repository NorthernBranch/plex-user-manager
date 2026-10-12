import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { defaultMonitor, type MonitorSettings } from './config.js';
export function effectiveMonitorSettings(store: Store): MonitorSettings {
  const settings = store.get<MonitorSettings>('monitor') ?? defaultMonitor;
  const selected = store.getSecret<{ id: string }>('server');
  const events = selected
    ? store.all<{ id: string; payload: string }>(
        "SELECT id,payload FROM campaigns WHERE type='maintenance' AND server=? AND status IN ('scheduled','dispatched')",
        selected.id,
      )
    : [];
  return {
    ...settings,
    maintenance: [
      ...settings.maintenance.filter((w) => !w.eventId),
      ...events.map((event) => {
        const p = JSON.parse(event.payload);
        return { start: p.start, end: p.end, eventId: event.id };
      }),
    ],
  };
}
export function maintenanceDigest(windows: MonitorSettings['maintenance']) {
  const values = [...new Set(windows.map((w) => `${w.start}|${w.end}`))].sort();
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
