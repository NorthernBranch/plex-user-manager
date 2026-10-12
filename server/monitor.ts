import { randomUUID } from 'node:crypto';
import { type MonitorSettings } from './config.js';
import { Store } from './store.js';
import { effectiveMonitorSettings } from './maintenance.js';
import { notificationRecipients } from './recipients.js';

export type HealthState =
  'healthy' | 'suspected failure' | 'confirmed outage' | 'recovery pending' | 'recovered';
type State = {
  state: HealthState;
  last?: number;
  failingSince?: number;
  successes: number;
  incident?: string;
  lastOk?: boolean;
  unknown: boolean;
};
export type Incident = {
  id: string;
  started: number;
  confirmed: number;
  recovered: number | null;
  observed: number;
  scope: string;
};
export function inMaintenance(settings: MonitorSettings, at: number) {
  return settings.maintenance.some((w) => Date.parse(w.start) <= at && at < Date.parse(w.end));
}
export class Monitor {
  private busy = false;
  private generation = 0;
  constructor(
    private store: Store,
    public scope = 'local Plex identity API',
    private local = true,
  ) {}
  settings() {
    return effectiveMonitorSettings(this.store);
  }
  state(): State {
    return this.store.get<State>('health') ?? { state: 'healthy', successes: 0, unknown: true };
  }
  restart(now = Date.now()) {
    this.generation++;
    const state = this.state();
    this.store.transaction(() => {
      this.event(now, 'Monitoring restarted: unobserved time is unknown.', state.incident);
      state.last = undefined;
      state.lastOk = undefined;
      state.successes = 0;
      state.unknown = true;
      state.failingSince = undefined;
      state.state = state.incident ? 'confirmed outage' : 'healthy';
      this.store.set('health', state);
    });
  }
  private event(at: number, event: string, incident?: string) {
    this.store.run(
      'INSERT INTO timeline(at,incident,event) VALUES(?,?,?)',
      at,
      incident ?? null,
      event,
    );
  }
  private enqueue(
    incident: Incident,
    kind: 'outage' | 'recovery',
    at: number,
    settings: MonitorSettings,
  ) {
    const suppressed =
      inMaintenance(settings, at) || (this.local && settings.authority === 'external');
    const server = this.store.getSecret<{ id: string }>('server');
    for (const recipient of notificationRecipients(this.store, settings, server?.id).filter(
      (r) => r[kind],
    )) {
      const replace = (template: string) =>
        template.replace(
          /\{\{(incident|started|recovered|downtime|scope)\}\}/g,
          (_, key: string) =>
            ({
              incident: incident.id,
              started: new Date(incident.started).toISOString(),
              recovered: incident.recovered
                ? new Date(incident.recovered).toISOString()
                : 'pending',
              downtime: `${Math.round(incident.observed / 1000)} seconds`,
              scope: incident.scope,
            })[key] ?? '',
        );
      this.store.run(
        'INSERT OR IGNORE INTO deliveries(incident,kind,recipient,subject,body,status,next) VALUES(?,?,?,?,?,?,?)',
        incident.id,
        kind,
        recipient.email.toLowerCase(),
        replace(kind === 'outage' ? settings.outageSubject : settings.recoverySubject),
        replace(kind === 'outage' ? settings.outageBody : settings.recoveryBody),
        suppressed ? 'suppressed' : 'pending',
        at,
      );
      if (suppressed)
        this.store.run(
          'UPDATE deliveries SET error=? WHERE incident=? AND kind=? AND recipient=?',
          inMaintenance(settings, at)
            ? 'Suppressed by maintenance window.'
            : 'Suppressed by external alert authority.',
          incident.id,
          kind,
          recipient.email,
        );
    }
  }
  observe(ok: boolean, now = Date.now()) {
    const settings = this.settings();
    const state = this.state();
    this.store.transaction(() => {
      // Gaps exceeding two scheduled intervals cannot establish continuous failure.
      const gap = state.last !== undefined && now - state.last > settings.intervalSeconds * 2000;
      if (gap) {
        this.event(now, 'Probe gap: elapsed time is unknown.', state.incident);
        state.failingSince = undefined;
        state.successes = 0;
        state.unknown = true;
        if (!state.incident) state.state = 'healthy';
      }
      if (state.incident && state.last !== undefined && !gap && state.lastOk === false)
        this.store.run(
          'UPDATE incidents SET observed=observed+? WHERE id=?',
          Math.max(0, now - state.last),
          state.incident,
        );
      if (!ok) {
        state.successes = 0;
        if (!state.incident) {
          state.failingSince ??= now;
          if (state.state !== 'suspected failure') this.event(now, 'Failure suspected.');
          state.state = 'suspected failure';
          if (now - state.failingSince >= settings.failureSeconds * 1000) {
            const incident: Incident = {
              id: randomUUID(),
              started: state.failingSince,
              confirmed: now,
              recovered: null,
              observed: now - state.failingSince,
              scope: this.scope,
            };
            this.store.run(
              'INSERT INTO incidents(id,started,confirmed,observed,scope) VALUES(?,?,?,?,?)',
              incident.id,
              incident.started,
              now,
              incident.observed,
              this.scope,
            );
            state.incident = incident.id;
            state.state = 'confirmed outage';
            this.event(now, 'Outage confirmed.', incident.id);
            this.enqueue(incident, 'outage', now, settings);
          }
        } else {
          if (!inMaintenance(settings, now) && (!this.local || settings.authority === 'local'))
            this.store.run(
              "UPDATE deliveries SET status='pending',next=?,error=NULL WHERE incident=? AND kind='outage' AND status='suppressed' AND error IN ('Suppressed by maintenance window.','Suppressed by maintenance or external alert authority.')",
              now,
              state.incident,
            );
          if (state.state === 'recovery pending')
            this.event(now, 'Recovery failed; incident continues.', state.incident);
          state.state = 'confirmed outage';
        }
      } else if (state.incident) {
        state.successes++;
        state.state = 'recovery pending';
        if (state.successes === 1)
          this.event(now, 'Recovery awaiting confirmation.', state.incident);
        if (state.successes >= settings.recoveryCount) {
          this.store.run('UPDATE incidents SET recovered=? WHERE id=?', now, state.incident);
          const incident = this.store.one<Incident>(
            'SELECT * FROM incidents WHERE id=?',
            state.incident,
          )!;
          // Unsent outage messages become stale. A send already in flight settles before recovery.
          this.store.run(
            "UPDATE deliveries SET status='superseded',error='Recovered before outage delivery.' WHERE incident=? AND kind='outage' AND status IN ('pending','failed')",
            incident.id,
          );
          this.enqueue(incident, 'recovery', now, settings);
          for (const recipient of notificationRecipients(
            this.store,
            settings,
            this.store.getSecret<{ id: string }>('server')?.id,
          ).filter((r) => r.outage))
            this.store.run(
              "UPDATE deliveries SET status='suppressed',error='No outage was delivered to this recipient.' WHERE incident=? AND recipient=? AND kind='recovery' AND status='pending' AND NOT EXISTS(SELECT 1 FROM deliveries o WHERE o.incident=deliveries.incident AND o.recipient=deliveries.recipient AND o.kind='outage' AND o.status IN ('sent','sending'))",
              incident.id,
              recipient.email.toLowerCase(),
            );
          this.event(now, 'Recovery confirmed. Observed downtime excludes gaps.', incident.id);
          state.incident = undefined;
          state.failingSince = undefined;
          state.state = 'recovered';
          state.successes = 0;
        }
      } else {
        if (state.state === 'suspected failure')
          this.event(now, 'Transient failure ended; no notification.');
        state.state = 'healthy';
        state.failingSince = undefined;
        state.successes = 0;
      }
      state.last = now;
      state.lastOk = ok;
      state.unknown = false;
      this.store.set('health', state);
    });
  }
  async probe(check: () => Promise<void>, now?: number) {
    if (this.busy || !this.settings().enabled) return;
    this.busy = true;
    const generation = this.generation;
    try {
      let ok = true;
      try {
        await check();
      } catch {
        ok = false;
      }
      if (generation !== this.generation) return;
      this.observe(ok, now ?? Date.now());
      return ok;
    } finally {
      this.busy = false;
    }
  }
}
