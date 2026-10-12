import { useState } from 'react';
import { parseFilters } from '../server/filters';
import type { Restrictions } from '../server/plex';
import { Field } from './components';

const fields = [
  ['movieRatings', 'Movie content ratings'],
  ['movieLabels', 'Allowed movie labels'],
  ['tvRatings', 'TV content ratings'],
  ['tvLabels', 'Allowed TV labels'],
  ['musicLabels', 'Allowed music labels'],
] as const;
type Draft = Record<(typeof fields)[number][0], string>;
const split = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
function initialDraft(filters: Record<string, string>): { draft: Draft; error: string } {
  try {
    const values = parseFilters(filters);
    return {
      draft: {
        movieRatings: values.movies.ratings.join(', '),
        movieLabels: values.movies.labels.join(', '),
        tvRatings: values.television.ratings.join(', '),
        tvLabels: values.television.labels.join(', '),
        musicLabels: values.music.labels.join(', '),
      },
      error: '',
    };
  } catch {
    return {
      draft: { movieRatings: '', movieLabels: '', tvRatings: '', tvLabels: '', musicLabels: '' },
      error: 'Existing Plex filters cannot be safely edited here. Use Plex Web.',
    };
  }
}
export function RestrictionsEditor({
  filters,
  disabled,
  onApply,
}: {
  filters: Record<string, string>;
  disabled: boolean;
  onApply: (values: Restrictions) => void;
}) {
  const [initial] = useState(() => initialDraft(filters));
  const [draft, setDraft] = useState(initial.draft);
  const [review, setReview] = useState(false);
  const same = (a: string, b: string) =>
    JSON.stringify(split(a).sort()) === JSON.stringify(split(b).sort());
  const changed = fields.some(([key]) => !same(draft[key], initial.draft[key]));
  return (
    <>
      {initial.error && (
        <p role="alert" className="error">
          {initial.error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && !initial.error && changed) setReview(true);
        }}
      >
        <fieldset disabled={disabled || !!initial.error}>
          <legend>Content filters (comma-separated values)</legend>
          {fields.map(([name, label]) => (
            <Field key={name} label={label}>
              <input
                name={name}
                maxLength={2000}
                value={draft[name]}
                onChange={(e) => {
                  setDraft({ ...draft, [name]: e.target.value });
                  setReview(false);
                }}
              />
            </Field>
          ))}
          <p>Existing values are prefilled. Emptying a field removes that restriction.</p>
          <button className="secondary" disabled={!changed}>
            Review &amp; replace restrictions
          </button>
        </fieldset>
      </form>
      {review && (
        <section className="preview" aria-labelledby="restrictions-preview-title">
          <h3 id="restrictions-preview-title">Restriction change preview</h3>
          <p>These filters replace this account’s sharing restrictions across your servers.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Filter</th>
                  <th scope="col">Current</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {fields.map(([key, label]) => {
                  const before = split(initial.draft[key]);
                  const after = split(draft[key]);
                  const unchanged = same(draft[key], initial.draft[key]);
                  return (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>{before.join(', ') || 'No restriction'}</td>
                      <td>
                        {after.join(', ') ||
                          (before.length ? 'No restriction (cleared)' : 'No restriction')}
                        {unchanged && ' (unchanged)'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            disabled={disabled || !!initial.error || !changed}
            onClick={() => {
              if (
                confirm(
                  'Apply the reviewed content restrictions for this account across all your server shares?',
                )
              )
                onApply({
                  movies: { ratings: split(draft.movieRatings), labels: split(draft.movieLabels) },
                  television: { ratings: split(draft.tvRatings), labels: split(draft.tvLabels) },
                  music: { labels: split(draft.musicLabels) },
                });
            }}
          >
            Apply reviewed restrictions
          </button>
          <button type="button" className="secondary" onClick={() => setReview(false)}>
            Cancel review
          </button>
        </section>
      )}
    </>
  );
}
