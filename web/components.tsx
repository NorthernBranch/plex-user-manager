import type { ReactNode } from 'react';
import type { Library } from './types';
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Libraries({
  libraries,
  value,
  onChange,
}: {
  libraries: Library[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset className="choices">
      <legend>Library access</legend>
      {libraries.map((l) => (
        <label key={l.id}>
          <input
            type="checkbox"
            checked={value.includes(l.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, l.id] : value.filter((id) => id !== l.id))
            }
          />
          <span>
            {l.title}
            <small>{l.type}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
export function JsonHistory({
  items,
  columns,
}: {
  items: any[];
  columns: { key: string; label: string; date?: boolean }[];
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={item.id ?? i}>
              {columns.map((c) => (
                <td key={c.key}>
                  {c.date
                    ? item[c.key]
                      ? new Date(item[c.key]).toLocaleString()
                      : '—'
                    : String(item[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <p className="empty">No records yet.</p>}
    </div>
  );
}
