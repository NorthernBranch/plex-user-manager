import { describe, it, expect } from 'vitest';
import { parseFilters, serializeFilters } from '../server/filters.js';
describe('restriction prefilling', () => {
  it('preserves all supported existing fields and encoded labels', () => {
    const values = {
      movies: { ratings: ['G', 'PG'], labels: ['Family films', 'A&B'] },
      television: { ratings: ['TV-PG'], labels: ['Sample shows'] },
      music: { labels: ['Sample music'] },
    };
    expect(parseFilters(serializeFilters(values))).toEqual(values);
    expect(parseFilters({})).toEqual({
      movies: { ratings: [], labels: [] },
      television: { ratings: [], labels: [] },
      music: { labels: [] },
    });
  });
  it.each(['contentRating!=PG', 'label=bad%ZZ', 'label=A|label=B', 'label='])(
    'blocks unsafe replacement of unsupported filters: %s',
    (filterMovies) => {
      expect(() => parseFilters({ filterMovies })).toThrow('Use Plex Web');
    },
  );
});
