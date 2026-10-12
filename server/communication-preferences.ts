// Pure shared values: safe to import in the frontend without backend dependencies.
export const categories = [
  'outage',
  'recovery',
  'maintenance',
  'announcement',
  'welcome',
  'expiry',
] as const;
export type Category = (typeof categories)[number];
export type Preferences = Record<Category, boolean>;
export const noPreferences: Preferences = {
  outage: false,
  recovery: false,
  maintenance: false,
  announcement: false,
  welcome: false,
  expiry: false,
};
