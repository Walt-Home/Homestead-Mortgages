/**
 * A figure, or an honest dash.
 *
 * There were two of these, one per screen, and they disagreed about null. The
 * bank screen's took `string | null` and rendered a dash for a figure the
 * engine could not compute; the review screen's took `string`, which pushes
 * the decision about an absent number back onto every caller and lets one of
 * them decide that absent means zero.
 *
 * The null-tolerant one is the one kept. `null` means the engine could not
 * compute it — usually because income still needs a branch — and rendering a
 * zero, or omitting the row, would both read as an answer. A dash reads as
 * what it is. A caller that already holds a string loses nothing by handing it
 * to the wider type.
 */

export function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-sm text-ink-faint">{label}</dt>
      <dd className="super-figure mt-1 text-2xl text-ink">
        {value ?? <span className="text-ink-faint">—</span>}
      </dd>
      {note && <p className="mt-1 text-xs text-ink-muted">{note}</p>}
      {!value && !note && <p className="mt-1 text-xs text-ink-muted">still working this out</p>}
    </div>
  );
}
