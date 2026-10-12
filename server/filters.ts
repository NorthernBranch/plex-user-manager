import type { Restrictions } from './plex.js';
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
