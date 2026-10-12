import type { Restrictions } from './plex.js';
export function parseFilters(filters: Record<string, string>): Restrictions {
  const parse = (filter: string, allowed: string[]) => {
    const values: Record<string, string[]> = {};
    for (const entry of filter.split('|').filter(Boolean)) {
      const separator = entry.indexOf('=');
      const key = entry.slice(0, separator);
      if (separator < 1 || !allowed.includes(key) || Object.hasOwn(values, key))
        throw new Error('Existing Plex filters cannot be safely edited here. Use Plex Web.');
      let decoded: string;
      try {
        decoded = decodeURIComponent(entry.slice(separator + 1));
      } catch {
        throw new Error('Existing Plex filters cannot be safely edited here. Use Plex Web.');
      }
      const items = decoded.split(',');
      if (
        items.some((value) => !value || value !== value.trim() || value.length > 80) ||
        items.length > 50
      )
        throw new Error('Existing Plex filters cannot be safely edited here. Use Plex Web.');
      values[key] = items;
    }
    return values;
  };
  const movies = parse(filters.filterMovies ?? '', ['contentRating', 'label']);
  const television = parse(filters.filterTelevision ?? '', ['contentRating', 'label']);
  const music = parse(filters.filterMusic ?? '', ['label']);
  return {
    movies: { ratings: movies.contentRating ?? [], labels: movies.label ?? [] },
    television: { ratings: television.contentRating ?? [], labels: television.label ?? [] },
    music: { labels: music.label ?? [] },
  };
}
export function serializeFilters(values: Restrictions) {
  const format = (ratings: string[], labels: string[]) =>
    [
      ...(ratings.length ? [`contentRating=${ratings.map(encodeURIComponent).join('%2C')}`] : []),
      ...(labels.length ? [`label=${labels.map(encodeURIComponent).join('%2C')}`] : []),
    ].join('|');
  return {
    filterMovies: format(values.movies.ratings, values.movies.labels),
    filterTelevision: format(values.television.ratings, values.television.labels),
    filterMusic: format([], values.music.labels),
  };
}
export function filtersMatch(actual: Record<string, string>, expected: Record<string, string>) {
  const normalise = (filter: string) =>
    filter
      .split('|')
      .filter(Boolean)
      .map((entry) => {
        const [key, ...rest] = entry.split('=');
        const value = decodeURIComponent(rest.join('='));
        return `${key}=${value.split(',').sort().join(',')}`;
      })
      .sort()
      .join('|');
  try {
    return Object.keys(expected).every(
      (key) => normalise(actual[key] ?? '') === normalise(expected[key]),
    );
  } catch {
    return false;
  }
}
