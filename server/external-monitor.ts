import { Store } from './store.js';
import { Monitor } from './monitor.js';
import type { Heartbeat } from './heartbeat.js';
export class ExternalMonitor {
  constructor(
    private store: Store,
    private monitor: Monitor,
    private graceSeconds: number,
  ) {}
  tick(now = Date.now()) {
    if (!this.monitor.settings().enabled) {
      if (!this.monitor.state().unknown) this.monitor.restart(now);
      return;
    }
    const beat = this.store.get<Heartbeat>('heartbeat.received');
    if (!beat) return; // Pair once before detection can begin.
    const fresh = now - beat.at < this.graceSeconds * 1000;
    if (fresh && (beat.state === 'unknown' || beat.state === 'maintenance')) {
      // A deliberate pause is unknown, never a recovery claim.
      if (!this.monitor.state().unknown) this.monitor.restart(now);
      return;
    }
    this.monitor.observe(fresh && beat.state === 'healthy', now);
  }
}
