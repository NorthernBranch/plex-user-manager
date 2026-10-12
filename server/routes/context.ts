import type { Express } from 'express';
import type { Store } from '../store.js';
import type { Config } from '../config.js';
import type { PlexAdapter, SelectedServer } from '../plex.js';
import type { Access } from '../access.js';
import type { Monitor } from '../monitor.js';
import type { EmailQueue } from '../email.js';
export type AppServices = {
  app: Express;
  store: Store;
  config: Config;
  client: () => PlexAdapter;
  selected: () => SelectedServer;
  access: Access;
  monitor: Monitor;
  email: EmailQueue;
};
