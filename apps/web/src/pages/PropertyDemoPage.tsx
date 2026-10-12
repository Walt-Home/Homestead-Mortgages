/**
 * The county record, live: a page to show what the property vendors answer.
 *
 * A DEMO, not a borrower surface. It exists so a person can type an address,
 * pick the one Google Places offers, and read what CoreLogic says about the
 * parcel — the record, the valuation — and what the fixture still says about
 * the flood zone, with the raw response beneath. Nothing here touches a file.
 * The page is reachable only on a deployment that carries the sample
 * borrowers, and a sample borrower's own session can use it, because the
 * lookup is a read.
 *
 * It reuses screen 1's two calls exactly: `/property/suggest` for the
 * autocomplete and `/property/lookup` for the retrieval, on the GET the
 * persona gate lets through. Picking an address looks it up, as screen 1
 * does; there is no second button to press. The provider names on the answer
 * are what the registry reported, so the page cannot say CoreLogic answered
 * when the fixture did.
 */
import { useRef, useState } from "react";
import clsx from "clsx";
import type { Address, AvmEstimate, FloodDetermination, PropertyRecord } from "@hm/shared";
import { Working } from "../components/Working.js";
import { api, ApiError } from "../lib/api.js";
import { money } from "../lib/figures.js";

interface Suggestion {
  id: string;
  label: string;
  address: Address;
}

export interface LookupResponse {
  record: PropertyRecord;
  /** Null when the model will not price the parcel. */
  valuation: AvmEstimate | null;
  /** Null until a flood vendor has determined the zone. */
  flood: FloodDetermination | null;
  provider: string;
  providers?: { record: string; valuation: string | null; flood: string | null };
}

type Fetch =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "found"; result: LookupResponse; ms: number }
  | { kind: "failed"; err: unknown };

/**
 * What a failed lookup entitles the page to say, and never a value.
 *
 * An absence is not a fault. Google offers house numbers it has interpolated
 * between two it knows, and CoreLogic holds no record for those, so "no
 * record" is a true answer and is drawn as a plain notice. Only a lookup that
 * did not come back at all is drawn as a failure.
 */
export function lookupFailureCopy(err: unknown): {
  title: string;
  body: string;
  tone: "notice" | "danger";
} {
  if (err instanceof ApiError && err.code === "ADDRESS_NOT_FOUND") {
    return { title: "No record for that address", body: err.message, tone: "notice" };
  }
  if (err instanceof ApiError && err.status === 403) {
    return { title: "This session may not ask", body: err.message, tone: "notice" };
  }
  return {
    title: "The lookup did not come back",
    body: err instanceof Error ? err.message : "Something went wrong on the way to the vendor.",
    tone: "danger",
  };
}

/** How long the lookup took, in the unit a reader would use. */
export function elapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "TRAVIS" as the county reports itself; "Travis" as a person reads it. */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])[a-z]/g, (c) => c.toUpperCase());
}

const TYPE_LABEL: Record<string, string> = {
  single_family: "Single-family",
  condo: "Condo",
  townhouse: "Townhouse",
  two_to_four_unit: "2–4 unit",
  manufactured: "Manufactured",
  co_op: "Co-op",
};

/**
 * One figure off the record. A zero is a count nobody reported, so it is left
 * off. The note is a second line under the figure, for a date that would
 * otherwise break in the middle of a narrow column.
 */
function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number | null | undefined;
  note?: string;
}) {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="super-figure mt-0.5 text-base text-ink">{value}</dd>
      {note && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
    </div>
  );
}

/**
 * One part of the answer, with who answered it in the corner — the registry's
 * own name for the adapter, or "nobody" when no vendor was asked.
 */
function Panel({
  eyebrow,
  source,
  children,
}: {
  eyebrow: string;
  source: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="super-card">
      <div className="flex items-center justify-between gap-4">
        <p className="super-eyebrow">{eyebrow}</p>
        <span className="super-pill">{source ?? "nobody"}</span>
      </div>
      {children}
    </section>
  );
}

/** The answer, laid out to be read, with the bytes beneath it. */
export function LookupView({ result, ms }: { result: LookupResponse; ms: number }) {
  const r = result.record;
  const v = result.valuation;
  const f = result.flood;
  const providers = result.providers ?? {
    record: result.provider,
    valuation: v ? result.provider : null,
    flood: f ? result.provider : null,
  };
  return (
    <div className="mt-8 flex flex-col gap-4">
      <p className="text-sm text-ink-muted">Answered in {elapsed(ms)}.</p>

      <Panel eyebrow="County record" source={providers.record}>
        <h2 className="mt-3 font-display text-2xl text-ink">
          {TYPE_LABEL[r.propertyType] ?? r.propertyType}
          {r.attachment ? `, ${r.attachment}` : ""}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {titleCase(r.county)} County · APN {r.apn || "not reported"}
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          <Fact label="Units" value={r.units} />
          <Fact label="Bedrooms" value={r.bedrooms} />
          <Fact label="Bathrooms" value={r.bathrooms} />
          <Fact
            label="Living area"
            value={r.squareFeet ? `${r.squareFeet.toLocaleString()} sq ft` : null}
          />
          <Fact
            label="Lot"
            value={r.lotSizeSqFt ? `${r.lotSizeSqFt.toLocaleString()} sq ft` : null}
          />
          <Fact label="Year built" value={r.yearBuilt} />
          <Fact label="Assessed value" value={r.assessedValue ? money(r.assessedValue) : null} />
          <Fact
            label="Property tax"
            value={r.annualPropertyTax ? `${money(r.annualPropertyTax)}/yr` : null}
          />
          <Fact label="Association" value={r.hoaExists ? "On record" : "None on record"} />
          <Fact label="Owner of record" value={r.ownerOfRecord} />
          <Fact
            label="Last sale"
            value={r.lastSale ? money(r.lastSale.price) : null}
            note={r.lastSale ? `on ${r.lastSale.soldOn}` : undefined}
          />
        </dl>
        {r.legalDescription && <p className="mt-5 text-xs text-ink-faint">{r.legalDescription}</p>}
      </Panel>

      <Panel eyebrow="Valuation" source={providers.valuation}>
        {v ? (
          <>
            <h2 className="super-figure mt-3 font-display text-2xl text-ink">{money(v.value)}</h2>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Fact label="Range" value={`${money(v.low)} – ${money(v.high)}`} />
              <Fact label="Confidence" value={`${v.confidence} / 100`} />
              <Fact label="As of" value={v.asOf} />
            </dl>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-soft">
            No automated valuation. The model would not price this parcel, which is a fact about the
            building and not about the address.
          </p>
        )}
      </Panel>

      <Panel eyebrow="Flood determination" source={providers.flood}>
        {f ? (
          <>
            <h2 className="mt-3 font-display text-2xl text-ink">Zone {f.zone}</h2>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Fact
                label="Special flood hazard area"
                value={f.inSpecialFloodHazardArea ? "Yes" : "No"}
              />
              <Fact label="Insurance required" value={f.insuranceRequired ? "Yes" : "No"} />
              <Fact label="Community" value={f.communityId} />
              <Fact label="Determined on" value={f.determinedOn} />
            </dl>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-soft">
            Not determined. No flood vendor is wired yet; a certified determination is a separate
            product.
          </p>
        )}
      </Panel>

      <details className="super-card">
        <summary className="super-link-quiet cursor-pointer text-sm">The raw response</summary>
        <pre className="mt-4 overflow-x-auto text-xs leading-relaxed text-ink-soft">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Failure({ err }: { err: unknown }) {
  const copy = lookupFailureCopy(err);
  return (
    <div className={clsx("super-notice mt-6", copy.tone === "danger" && "super-notice-danger")}>
      <p className="text-sm font-medium text-ink">{copy.title}</p>
      <p className="mt-1 text-sm text-ink-soft">{copy.body}</p>
    </div>
  );
}

export function PropertyDemoPage() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // Whether Google has answered the current query: "nothing matched" is only
  // true once it has, and must not flash while the request is in flight.
  const [searched, setSearched] = useState(false);
  const [fetching, setFetching] = useState<Fetch>({ kind: "idle" });
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function onQueryChange(value: string) {
    setQuery(value);
    setSearched(false);
    setFetching({ kind: "idle" });
    clearTimeout(debounce.current);
    if (value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const res = await api.get<{ suggestions: Suggestion[] }>(
          `/property/suggest?q=${encodeURIComponent(value)}`,
        );
        setSuggestions(res.suggestions);
      } catch {
        setSuggestions([]);
      }
      setSearched(true);
    }, 200);
  }

  async function choose(suggestion: Suggestion) {
    setQuery(suggestion.label);
    setSuggestions([]);
    setSearched(false);
    await lookup(suggestion.address);
  }

  async function lookup(address: Address) {
    setFetching({ kind: "looking" });
    const started = performance.now();
    const params = new URLSearchParams({
      line1: address.line1,
      ...(address.line2 ? { line2: address.line2 } : {}),
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
    });
    try {
      const result = await api.get<LookupResponse>(`/property/lookup?${params.toString()}`);
      setFetching({ kind: "found", result, ms: performance.now() - started });
    } catch (err) {
      setFetching({ kind: "failed", err });
    }
  }

  // `Chrome` already renders the header, the footer and the page frame, so
  // this returns a section rather than a screen. The column is the header's
  // and the footer's, so the three line up.
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6">
      <p className="super-eyebrow">Vendor demo</p>
      <h1 className="mt-2 font-display text-3xl text-ink sm:text-4xl">The county record, live</h1>
      <p className="mt-3 text-base text-ink-soft">
        Type an address and pick the one Google offers. The record and the valuation are
        CoreLogic&rsquo;s; the flood zone is still the fixture&rsquo;s. Nothing here touches a file.
      </p>

      <div className="mt-8">
        <label className="super-label" htmlFor="demo-address">
          Address
        </label>
        <div className="relative">
          <input
            id="demo-address"
            className="super-input"
            autoComplete="off"
            placeholder="Start typing a street address"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && suggestions[0]) {
                e.preventDefault();
                void choose(suggestions[0]);
              }
            }}
          />
          {suggestions.length > 0 && (
            <ul
              className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-rule bg-ground shadow-menu"
              aria-label="Suggested addresses"
            >
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2.5 text-left text-sm text-ink hover:bg-raised"
                    onClick={() => void choose(s)}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {searched && suggestions.length === 0 && fetching.kind === "idle" ? (
          <p className="mt-2 text-xs text-ink-muted">Google offers nothing for that.</p>
        ) : (
          <p className="mt-2 text-xs text-ink-muted">
            Pick a real building. Google also offers house numbers it has guessed between two it
            knows, and the county holds no record for those.
          </p>
        )}
      </div>

      {fetching.kind === "looking" && (
        <Working
          steps={[
            { label: "Checking the address", ms: 500 },
            { label: "Reading the county record", ms: 900 },
            { label: "Estimating the value", ms: 1200 },
          ]}
        />
      )}
      {fetching.kind === "failed" && <Failure err={fetching.err} />}
      {fetching.kind === "found" && <LookupView result={fetching.result} ms={fetching.ms} />}
    </div>
  );
}
