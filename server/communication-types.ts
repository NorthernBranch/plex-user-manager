import type { AudienceRule } from './communication-audience.js';
import type { SelectedServer, PlexUser, Library } from './plex.js';
export type Campaign = {
  id: string;
  type: 'announcement' | 'maintenance';
  server: string;
  revision: number;
  status: string;
  subject: string;
  body: string;
  payload: string;
  audience: string;
  scheduled: number | null;
  created: number;
  updated: number;
};
export type Payload = {
  rule: AudienceRule;
  title?: string;
  explanation?: string;
  start?: string;
  end?: string;
  leads?: number[];
  noticeSubject?: string;
  noticeBody?: string;
};
export type Job = {
  id: string;
  source: string;
  revision: number;
  kind: string;
  due: number;
  status: string;
  payload: string;
  reason: string | null;
  attempts: number;
  next: number;
};
export type Expiry = {
  server: string;
  user: string;
  due: number;
  revision: number;
  status: string;
  error: string | null;
};
export type Membership = {
  server: string;
  user: string;
  share_id: string;
  kind: string;
  status: string;
  generation: number;
  welcome: string;
  observed: number;
};

export type CommunicationSnapshot = {
  server: SelectedServer;
  users: PlexUser[];
  libraries: Library[];
};
