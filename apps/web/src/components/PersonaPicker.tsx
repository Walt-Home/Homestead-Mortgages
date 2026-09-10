/**
 * "Or look around as a sample borrower."
 *
 * Under the Google button on both sign-in surfaces, and only where the server
 * says the sample borrowers exist. Clicking a row is a real sign-in — a real
 * session for a real user row — so what a tester then walks is the product,
 * not a mock of it. Nothing they do can change anything: every persona file is
 * a demo file, and the session itself is refused every write.
 *
 * The pill is the LIVE state of the persona's application, rendered through
 * the same catalog the file header and the file list use. A persona that
 * drifted out of the state it was seeded into shows the state it is actually
 * in, because this page is where someone would notice.
 *
 * The row that cannot be offered is rendered as text with its reason, rather
 * than dropped. A tester who has been told the model has nineteen states
 * should be able to see which ones this build cannot show them and why.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { entryFor } from "../lib/states.js";
import { timelineDate } from "../lib/ledger.js";
import { StatusPill } from "./StatusPill.js";

export interface PersonaRow {
  key: string;
  name: string;
  story: string;
  /** The application's live status, or null before the seed has run. */
  state: string | null;
  available: boolean;
  unavailableBecause: string | null;
  seededAt: string | null;
}

export function PersonaPicker() {
  const { signInAsPersona } = useAuth();
  const { data } = useQuery({
    queryKey: ["personas"],
    queryFn: () => api.get<{ personas: PersonaRow[] }>("/auth/personas"),
    // The flag can be off on this deployment, in which case the route is not
    // mounted at all. One failure is the whole answer; retrying it is noise.
    retry: false,
  });

  const personas = data?.personas ?? [];
  if (personas.length === 0) return null;

  return (
    <div className="mt-10 w-full max-w-measure-prose text-left">
      <p className="text-xs text-ink-faint">Or look around as a sample borrower</p>
      <ul className="mt-3 flex flex-col gap-2">
        {personas.map((p) => (
          <li key={p.key}>
            {p.available ? (
              <button className="super-choice" onClick={() => void signInAsPersona(p.key)}>
                <PersonaLine row={p} />
              </button>
            ) : (
              <div className="super-choice">
                <PersonaLine row={p} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The name, the state, and one line about the person.
 *
 * Shared by both row shapes so the disabled one is not quietly a different
 * design — the difference between them is whether it can be pressed, which is
 * the only difference a reader should have to see.
 */
function PersonaLine({ row }: { row: PersonaRow }) {
  const entry = entryFor(row.state);
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-base text-ink">{row.name}</span>
        {entry && <StatusPill tone={entry.tone}>{entry.pill}</StatusPill>}
      </span>
      <span className="text-xs text-ink-soft">{row.story}</span>
      {row.unavailableBecause && (
        <span className="text-xs text-ink-faint">{row.unavailableBecause}</span>
      )}
      {/*
        When this row was put here, which is how old the state beside it is.
        A sample borrower is seeded once and then left alone, so a tester
        reading a pill deserves to know whether it was written this morning or
        three deploys ago.
      */}
      {row.seededAt && (
        <span className="text-xs text-ink-faint">seeded {timelineDate(row.seededAt)}</span>
      )}
    </span>
  );
}
