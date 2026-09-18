/**
 * The county record, live: a page to show what the property vendors answer.
 *
 * A DEMO, not a borrower surface. It exists so a person can type an address,
 * pick the one Google Places offers, press one button, and read what
 * CoreLogic says about the parcel — the record, the valuation — and what the
 * fixture still says about the flood zone, with the raw response beside it.
 * Nothing here touches a file. The page is reachable only on a deployment
 * that carries the sample borrowers, and a sample borrower's own session can
 * use it, because the lookup is a read.
 *
 * It reuses screen 1's two calls exactly: `/property/suggest` for the
 * autocomplete and `/property/lookup` for the retrieval, on the GET the
 * persona gate lets through. The provider names on the answer are what the
 * registry reported, so the page cannot say CoreLogic answered when the
 * fixture did.
 */
import { useRef, useState } from "react";
import type { Address, AvmEstimate, FloodDetermination, PropertyRecord } from "@hm/shared";
import { api, ApiError } from "../lib/api.js";
import { money } from "../lib/figures.js";

interface Suggestion {
  id: string;
  label: string;
  address: Address;
}

export interface LookupResponse {
  record: PropertyRecord;
  valuation: AvmEstimate;
  flood: FloodDetermination;
  provider: string;
  providers?: { record: string; valuation: string; flood: string };
}

type Fetch =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "found"; result: LookupResponse; ms: number }
  | { kind: "failed"; err: unknown };

/** What a failed lookup entitles the page to say, and never a value. */
export function lookupFailureCopy(err: unknown): { title: string; body: string } {
  if (err instanceof ApiError && err.code === "ADDRESS_NOT_FOUND") {
    return {
      title: "No record for that address",
      body: err.message,
    };
  }
  if (err instanceof ApiError && err.status === 403) {
    return {
      title: "This session may not ask",
      body: err.message,
    };
  }
  return {
    title: "The lookup did not come back",
    body: err instanceof Error ? err.message : "Something went wrong on the way to the vendor.",
  };
}

const TYPE_LABEL: Record<string, string> = {
  single_family: "Single-family",
  condo: "Condo",
  townhouse: "Townhouse",
  two_to_four_unit: "2–4 unit",
  manufactured: "Manufactured",
  co_op: "Co-op",
};

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  return (
    <div>
      <dt className="super-label">{label}</dt>
      <dd className="mt-0.5 text-base text-ink">{value}</dd>
    </div>
  );
}

/** The answer, laid out to be read, with the bytes beneath it. */
export function LookupView({ result, ms }: { result: LookupResponse; ms: number }) {
  const r = result.record;
  const v = result.valuation;
  const f = result.flood;
  const providers = result.providers ?? {
    record: result.provider,
    valuation: result.provider,
    flood: result.provider,
  };
  return (
    <div className="mt-8 flex flex-col gap-6">
      <p className="text-sm text-ink-faint">
        Answered in {Math.round(ms)} ms. Record from <code>{providers.record}</code>, valuation from{" "}
        <code>{providers.valuation}</code>, flood from <code>{providers.flood}</code>.
      </p>

      <section className="rounded-lg border border-rule bg-surface p-6">
        <p className="super-eyebrow">The county record</p>
        <h2 className="mt-2 font-display text-2xl text-ink">
          {TYPE_LABEL[r.propertyType] ?? r.propertyType}
          {r.attachment ? `, ${r.attachment}` : ""}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {r.county} County · APN {r.apn || "not reported"}
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
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
            value={r.lastSale ? `${money(r.lastSale.price)} on ${r.lastSale.soldOn}` : null}
          />
        </dl>
        {r.legalDescription && <p className="mt-5 text-sm text-ink-faint">{r.legalDescription}</p>}
      </section>

      <section className="rounded-lg border border-rule bg-surface p-6">
        <p className="super-eyebrow">The valuation</p>
        <h2 className="mt-2 font-display text-2xl text-ink">{money(v.value)}</h2>
        <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          <Fact label="Range" value={`${money(v.low)} – ${money(v.high)}`} />
          <Fact label="Confidence" value={`${v.confidence} / 100`} />
          <Fact label="As of" value={v.asOf} />
        </dl>
      </section>

      <section className="rounded-lg border border-rule bg-surface p-6">
        <p className="super-eyebrow">The flood determination</p>
        <h2 className="mt-2 font-display text-2xl text-ink">Zone {f.zone}</h2>
        <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          <Fact
            label="Special flood hazard area"
            value={f.inSpecialFloodHazardArea ? "Yes" : "No"}
          />
          <Fact label="Insurance required" value={f.insuranceRequired ? "Yes" : "No"} />
          <Fact label="Community" value={f.communityId} />
          <Fact label="Determined on" value={f.determinedOn} />
        </dl>
      </section>

      <details className="rounded-lg border border-rule bg-surface p-6">
        <summary className="super-link cursor-pointer text-sm">The raw response</summary>
        <pre className="mt-4 overflow-x-auto text-xs text-ink-soft">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function oneLine(address: Address): string {
  const street = address.line2 ? `${address.line1}, ${address.line2}` : address.line1;
  return `${street}, ${address.city}, ${address.state} ${address.postalCode}`;
}

export function PropertyDemoPage() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [address, setAddress] = useState<Address | null>(null);
  const [fetching, setFetching] = useState<Fetch>({ kind: "idle" });
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function onQueryChange(value: string) {
    setQuery(value);
    setAddress(null);
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
    }, 200);
  }

  function choose(suggestion: Suggestion) {
    setQuery(suggestion.label);
    setAddress(suggestion.address);
    setSuggestions([]);
    setFetching({ kind: "idle" });
  }

  async function fetchRecord() {
    if (!address) return;
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
  // this returns a section rather than a screen.
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <p className="super-eyebrow">Vendor demo</p>
      <h1 className="mt-2 font-display text-4xl text-ink">The county record, live</h1>
      <p className="mt-4 max-w-prose text-base text-ink-soft">
        Type an address. Google Places offers the ones it knows; pick one and fetch what CoreLogic
        says about the parcel — the assessor record and the valuation — and what the flood
        determination still says from the fixture. Nothing here touches a file.
      </p>

      <label className="super-label mt-10 block" htmlFor="demo-address">
        Address
      </label>
      <input
        id="demo-address"
        className="super-input mt-1"
        autoComplete="off"
        placeholder="Start typing a street address"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {suggestions.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" aria-label="Suggested addresses">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="super-link text-left text-sm"
                onClick={() => choose(s)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {address && (
        <p className="mt-3 text-sm text-ink-soft">
          Selected: <span className="text-ink">{oneLine(address)}</span>
        </p>
      )}

      <button
        type="button"
        className="super-btn super-btn-primary mt-6"
        disabled={!address || fetching.kind === "looking"}
        onClick={fetchRecord}
      >
        {fetching.kind === "looking" ? "Fetching…" : "Fetch the property record"}
      </button>

      {fetching.kind === "failed" && (
        <div className="super-notice super-notice-danger mt-6">
          <p className="text-sm font-medium text-ink">{lookupFailureCopy(fetching.err).title}</p>
          <p className="mt-1 text-sm text-ink-soft">{lookupFailureCopy(fetching.err).body}</p>
        </div>
      )}
      {fetching.kind === "found" && <LookupView result={fetching.result} ms={fetching.ms} />}
    </div>
  );
}
