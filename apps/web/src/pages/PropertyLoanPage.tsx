/**
 * Screen 1 — property and loan.
 *
 * Six fields. Everything else about the property is retrieved from the address
 * and shown back for confirmation: type, units, year, size, beds, baths, lot,
 * APN, county, assessed value, tax, flood zone. A borrower asked to type their
 * own parcel number is a borrower who will get it wrong, and none of it is
 * knowledge they have that we do not.
 *
 * The gate at the end is the other reason this screen exists. A rough
 * affordability check on stated income costs nothing; finding out at the bank
 * screen that the loan never worked costs a credit pull and a bank connection. The
 * check only ever stops a file it can stop *safely* — see the server route,
 * which explains why a housing payment over the DTI ceiling cannot be rescued
 * by data we have not pulled.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { useLoanFile, type LoanFileView } from "../lib/file.js";
import { money } from "../lib/figures.js";
import { Why } from "../components/Why.js";
import { Working } from "../components/Working.js";

interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

interface Suggestion {
  id: string;
  label: string;
  address: Address;
}

interface PropertyRecord {
  apn: string;
  county: string;
  propertyType: string;
  units: number;
  yearBuilt: number;
  squareFeet: number;
  bedrooms: number;
  bathrooms: number;
  lotSizeSqFt: number;
  assessedValue: number;
  annualPropertyTax: number;
  hoaExists: boolean;
  monthlyAssociationDues?: number;
}

interface Lookup {
  record: PropertyRecord;
  valuation: { value: number; confidence: number };
  flood: { zone: string; insuranceRequired: boolean; inSpecialFloodHazardArea: boolean };
}

interface Affordability {
  verdict: "workable" | "tight" | "unworkable";
  loanAmount: number;
  ltv: number;
  estimatedMonthlyPayment: number;
  housingRatio: number;
  reasons: string[];
}

const TYPE_LABEL: Record<string, string> = {
  single_family: "Single family",
  condo: "Condo",
  townhouse: "Townhouse",
  two_to_four_unit: "2–4 unit",
  manufactured: "Manufactured",
  co_op: "Co-op",
};

/**
 * The three addresses the fixture holds records for.
 *
 * Hardcoded in the UI on purpose, and only reachable from the no-match panel.
 * It is prototype scaffolding — the day a real property-data vendor is wired
 * in, this constant and the panel that renders it are the whole of what gets
 * deleted.
 */
const SAMPLE_ADDRESSES: { label: string; address: Address }[] = [
  {
    label: "1247 Oak Street, Austin, TX 78704",
    address: { line1: "1247 Oak Street", city: "Austin", state: "TX", postalCode: "78704" },
  },
  {
    label: "540 Ponce De Leon Ave NE, Unit 312, Atlanta, GA 30308",
    address: {
      line1: "540 Ponce De Leon Ave NE",
      line2: "Unit 312",
      city: "Atlanta",
      state: "GA",
      postalCode: "30308",
    },
  },
  {
    label: "1247 Oak Street, San Jose, CA 95125",
    address: { line1: "1247 Oak Street", city: "San Jose", state: "CA", postalCode: "95125" },
  },
];

/**
 * What a failed lookup entitles the screen to say.
 *
 * A 403 is the request being turned down: no provider was asked, no county
 * was read, and the screen knows nothing at all about the property. Every
 * other failure is the retrieval running and coming back empty, which is a
 * fact about the address. Treating them alike printed an explanation of
 * somebody's county for a lookup that never happened — on the first thing a
 * borrower does here, and on every address for a sample borrower, whose
 * session is refused every write.
 *
 * Exported so the distinction is something a test can hold rather than an
 * expression inside a catch block.
 */
export function lookupMissFor(err: unknown): "refused" | "no_record" {
  return err instanceof ApiError && err.status === 403 ? "refused" : "no_record";
}

/**
 * What screen 1 puts back on itself when a borrower returns to a file.
 *
 * Every field the payload sends, because the payload sends all of them on
 * every save and a field this does not restore is a field the save overwrites
 * with whatever the screen started at. Two of them could only be wrong that
 * way: the property type has no control unless the county lookup missed, so a
 * condo came back as `single_family` with nothing on screen to say so and the
 * LTV ceiling and reserve tier moved with it; and the cash-out figure rendered
 * as an empty box that `Number(cashOut) || 0` then sent as zero.
 *
 * A function rather than the body of the effect so the correspondence between
 * what is sent and what is restored is something a test can hold.
 */
export function prefillFrom(file: Pick<LoanFileView, "loan" | "property"> | undefined): {
  address: Address;
  query: string;
  purpose: string;
  occupancy: string;
  propertyType: string;
  price: string;
  down: string;
  cashOut: string;
} | null {
  if (!file?.property) return null;
  return {
    address: file.property.address as Address,
    query: `${file.property.address.line1}, ${file.property.address.city}`,
    purpose: file.loan?.purpose ?? "purchase",
    occupancy: file.property.occupancy,
    propertyType: file.property.propertyType,
    price: String(file.property.valueOrPrice || ""),
    down: String(file.loan?.downPayment ?? ""),
    cashOut: String(file.loan?.cashToBorrower || ""),
  };
}

export function PropertyLoanPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const editing = Boolean(fileId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  /**
   * The same check every other screen makes.
   *
   * A sample file is shared with everyone and writable by nobody, so a
   * Continue button that looks live here PATCHes the file and is refused —
   * and screen 1 was the only one that let a borrower press it to find out.
   */
  const readOnly = data?.file.isDemo === true;

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [address, setAddress] = useState<Address | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [manual, setManual] = useState(false);
  /** Why the retrieval came back with nothing. See `lookupMissFor`. */
  const [lookupMiss, setLookupMiss] = useState<"refused" | "no_record" | null>(null);
  const [manualFields, setManualFields] = useState({
    line1: "",
    city: "",
    state: "",
    postalCode: "",
  });
  // Only asked when the lookup could not tell us. Six fields stays six fields
  // for anybody whose address we can actually retrieve.
  const [propertyType, setPropertyType] = useState("single_family");

  const [purpose, setPurpose] = useState("purchase");
  const [occupancy, setOccupancy] = useState("primary_residence");
  const [price, setPrice] = useState("");
  const [down, setDown] = useState("");
  const [income, setIncome] = useState("");
  const [cashOut, setCashOut] = useState("");

  const [correction, setCorrection] = useState<{
    note: string;
    corrections: Record<string, string>;
  } | null>(null);
  const [gate, setGate] = useState<Affordability | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refinancing = purpose !== "purchase";

  // Prefill when returning to edit. The address is already confirmed, so the
  // card comes back with it rather than making somebody re-search.
  useEffect(() => {
    const filled = prefillFrom(data?.file);
    if (!filled) return;
    setAddress(filled.address);
    setQuery(filled.query);
    setPurpose(filled.purpose);
    setOccupancy(filled.occupancy);
    setPropertyType(filled.propertyType);
    setPrice(filled.price);
    setDown(filled.down);
    setCashOut(filled.cashOut);
  }, [data?.file]);

  /* ── Autocomplete ─────────────────────────────────────────────────────── */

  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function onQueryChange(value: string) {
    setQuery(value);
    setAddress(null);
    setLookup(null);
    setLookupMiss(null);
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

  async function choose(suggestion: Suggestion) {
    setQuery(suggestion.label);
    setAddress(suggestion.address);
    setSuggestions([]);
    await lookupFor(suggestion.address);
  }

  /**
   * Retrieve, and treat "no record" as a normal outcome.
   *
   * A missing county record is not the borrower's problem and must never be a
   * dead end. We fall back to asking for the one thing the record would have
   * told us that we cannot do without — the property type — and let the flow
   * continue.
   */
  async function lookupFor(chosen: Address) {
    setAddress(chosen);
    setLooking(true);
    setError(null);
    setLookupMiss(null);
    try {
      const found = await api.post<Lookup>("/property/lookup", chosen);
      setLookup(found);
      setPropertyType(found.record.propertyType);
    } catch (err) {
      setLookup(null);
      setLookupMiss(lookupMissFor(err));
    } finally {
      setLooking(false);
    }
  }

  function useManualAddress() {
    const { line1, city, state, postalCode } = manualFields;
    if (!line1 || !city || state.length !== 2 || postalCode.length < 5) {
      setError("Fill in street, city, a two-letter state and a ZIP code.");
      return;
    }
    setError(null);
    setQuery(`${line1}, ${city}, ${state.toUpperCase()} ${postalCode}`);
    setManual(false);
    void lookupFor({ line1, city, state: state.toUpperCase(), postalCode });
  }

  /* ── Submit ───────────────────────────────────────────────────────────── */

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The button below is disabled, and a form still submits on Enter in a
    // browser that has no enabled submit button to consult.
    if (readOnly) return;
    if (!address) {
      setError("Enter the property address so we know what we are lending against.");
      return;
    }
    const priceNum = Number(price) || 0;
    const downNum = Number(down) || 0;
    const incomeNum = Number(income) || 0;
    // The figure is asserted as a fact on the person the moment it is stated,
    // and it is pinned as one of the six pieces of the application. A
    // stand-in for a blank field is therefore not a placeholder — it is a
    // one-dollar income on somebody's credit request. The input takes digits
    // only, so a typed `0` arrives here as a real answer of nothing.
    if (incomeNum <= 0) {
      setError("Tell us roughly what you earn a month — we can't check the loan works without it.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setGate(null);

    try {
      // The gate first. Spending a credit pull on a loan that cannot work is
      // the thing this screen exists to prevent.
      const verdict = await api.post<Affordability>("/property/affordability", {
        valueOrPrice: priceNum,
        downPayment: downNum,
        statedMonthlyIncome: incomeNum,
        occupancy,
        ...(lookup ? { annualPropertyTax: lookup.record.annualPropertyTax } : {}),
        ...(lookup?.record.monthlyAssociationDues
          ? { monthlyAssociationDues: lookup.record.monthlyAssociationDues }
          : {}),
      });
      if (verdict.verdict === "unworkable") {
        setGate(verdict);
        setSubmitting(false);
        return;
      }

      const payload = {
        purpose,
        address,
        // Retrieved when we have a record, restored from the file on a
        // revisit, and asked below only when neither could say.
        propertyType,
        occupancy,
        valueOrPrice: priceNum,
        loanAmount: Math.max(0, priceNum - downNum),
        downPayment: downNum,
        statedMonthlyIncome: incomeNum,
        ...(purpose === "cash_out_refinance" ? { cashToBorrower: Number(cashOut) || 0 } : {}),
      };

      const id = editing
        ? (await api.patch<{ id: string }>(`/files/${fileId}`, payload), fileId!)
        : (await api.post<{ id: string }>("/files", payload)).id;

      // Persist the retrieval against the file now that one exists. A 404 is
      // the expected answer for an address we hold no record for, and is not
      // a reason to stop.
      await api.post(`/files/${id}/property-data`, {}).catch(() => undefined);
      // Recorded for a human to check. Never blocking — a disputed bedroom
      // count must not stand between somebody and a Loan Estimate.
      if (correction) {
        await api.post(`/files/${id}/property-correction`, correction).catch(() => undefined);
      }
      await queryClient.invalidateQueries({ queryKey: ["file", id] });
      // The server records the stated income as a fact on the person, so it is
      // no longer carried here to keep it. It rides along only so screen 2 can
      // prefill the field the borrower has already answered.
      // `replace`, because this screen created the file. Left on the stack, one
      // press of Back returns to a form whose submit makes ANOTHER file, and the
      // borrower ends up with two applications for one house without ever
      // choosing to start a second.
      navigate(`/f/${id}/identity`, { state: { income: incomeNum }, replace: !editing });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSubmitting(false);
    }
  }

  const priceNum = Number(price) || 0;
  const downNum = Number(down) || 0;
  const loanAmount = Math.max(0, priceNum - downNum);
  const downPercent = priceNum > 0 ? Math.round((downNum / priceNum) * 100) : 0;

  return (
    <form onSubmit={submit} className="super-card">
      <h1 className="font-display text-2xl text-ink sm:text-3xl">
        Let&rsquo;s start with the property
      </h1>

      {/* 1 — Address */}
      <div className="mt-7">
        <label className="super-label" htmlFor="address">
          Property address
        </label>
        <div className="relative">
          <input
            id="address"
            className="super-input"
            value={query}
            autoComplete="off"
            placeholder="Start typing an address"
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-rule bg-ground shadow-menu">
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
        <Why>
          The address tells us the county records, the assessed value, the tax bill and the flood
          zone. That is a dozen questions we do not have to ask you.
        </Why>

        {/* Nothing matched. Never a dead end. */}
        {query.trim().length >= 3 && suggestions.length === 0 && !address && !looking && (
          <div className="super-notice mt-3">
            <p className="text-sm text-ink-soft">
              No match. This prototype can only retrieve records for three sample addresses:
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {SAMPLE_ADDRESSES.map((sample) => (
                <li key={sample.label}>
                  <button
                    type="button"
                    className="super-link text-left text-sm"
                    onClick={() => {
                      setQuery(sample.label);
                      setSuggestions([]);
                      void lookupFor(sample.address);
                    }}
                  >
                    {sample.label}
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="super-link-quiet mt-3 text-sm"
              onClick={() => setManual((m) => !m)}
            >
              {manual ? "Never mind" : "Or enter any address manually"}
            </button>

            {manual && (
              <div className="mt-3 flex flex-col gap-2">
                <input
                  className="super-input"
                  placeholder="Street address"
                  value={manualFields.line1}
                  onChange={(e) => setManualFields((f) => ({ ...f, line1: e.target.value }))}
                />
                <input
                  className="super-input"
                  placeholder="City"
                  value={manualFields.city}
                  onChange={(e) => setManualFields((f) => ({ ...f, city: e.target.value }))}
                />
                <div className="flex gap-2">
                  <input
                    className="super-input"
                    placeholder="ST"
                    maxLength={2}
                    value={manualFields.state}
                    onChange={(e) => setManualFields((f) => ({ ...f, state: e.target.value }))}
                  />
                  <input
                    className="super-input"
                    placeholder="ZIP code"
                    value={manualFields.postalCode}
                    onChange={(e) => setManualFields((f) => ({ ...f, postalCode: e.target.value }))}
                  />
                </div>
                <button
                  type="button"
                  className="super-btn super-btn-outline self-start"
                  onClick={useManualAddress}
                >
                  Use this address
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {looking && (
        <Working
          steps={[
            { label: "Checking the address", ms: 500 },
            { label: "Reading the county record", ms: 900 },
            { label: "Estimating the value and flood zone", ms: 1200 },
          ]}
        />
      )}

      {lookup && (
        <PropertyCard
          lookup={lookup}
          correction={correction}
          onCorrect={setCorrection}
          onWrongAddress={() => {
            setLookup(null);
            setAddress(null);
            setLookupMiss(null);
            setCorrection(null);
            setQuery("");
          }}
        />
      )}

      {/*
        We have an address and no record to show for it, for one of two
        reasons, and they are not the same sentence.

        A refusal is not a finding. The request was turned down before any
        provider was asked, so the screen has learned nothing whatsoever about
        the property — and "we could not find public records for this address"
        is a claim about the county that nobody made. The other case is the
        prototype's own limit, and the words for that were already on this
        screen: three sample addresses hold records, and any other one comes
        back empty.

        Either way, ask for the one thing the record would have told us that
        the loan genuinely cannot be underwritten without. Everything else the
        card would have shown is nice to have; the property type changes the
        LTV ceiling and the reserve tier.
      */}
      {lookupMiss && address && (
        <div className="super-notice mt-5">
          {lookupMiss === "refused" ? (
            <>
              <p className="text-sm font-medium text-ink">We have not looked this address up</p>
              <p className="mt-1 text-sm text-ink-soft">
                The lookup was refused for this session, so nothing here comes from a public record.
                It does not stop your application.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-ink">We hold no record for this address</p>
              <p className="mt-1 text-sm text-ink-soft">
                This prototype can only retrieve records for three sample addresses. It does not
                stop your application — we will just confirm the details later.
              </p>
            </>
          )}
          <div className="mt-3">
            <label className="super-label" htmlFor="ptype">
              What kind of property is it?
            </label>
            <select
              id="ptype"
              className="super-input"
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value)}
            >
              <option value="single_family">Single family house</option>
              <option value="condo">Condo</option>
              <option value="townhouse">Townhouse</option>
              <option value="two_to_four_unit">2–4 unit building</option>
              <option value="manufactured">Manufactured home</option>
              <option value="co_op">Co-op</option>
            </select>
          </div>
        </div>
      )}

      {/* 2 — Purpose */}
      <Field className="mt-7" label="Are you buying or refinancing?" htmlFor="purpose">
        <select
          id="purpose"
          className="super-input"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        >
          <option value="purchase">Buying</option>
          <option value="rate_term_refinance">Refinancing</option>
          <option value="cash_out_refinance">Refinancing and taking cash out</option>
        </select>
      </Field>

      {/* 3 — Occupancy */}
      <Field className="mt-5" label="How will you use it?" htmlFor="occupancy">
        <select
          id="occupancy"
          className="super-input"
          value={occupancy}
          onChange={(e) => setOccupancy(e.target.value)}
        >
          <option value="primary_residence">My primary home</option>
          <option value="second_home">A second home</option>
          <option value="investment">An investment property</option>
        </select>
      </Field>

      {/* 4 & 5 — Money */}
      <Field
        className="mt-5"
        label={refinancing ? "What is it worth, roughly?" : "Purchase price"}
        htmlFor="price"
      >
        <input
          id="price"
          className="super-input"
          inputMode="numeric"
          required
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ""))}
        />
        {lookup && (
          <p className="mt-1.5 text-xs text-ink-muted">
            Our estimate for this address is {money(lookup.valuation.value)}.
          </p>
        )}
      </Field>

      <Field
        className="mt-5"
        label={refinancing ? "How much equity are you keeping?" : "Down payment"}
        htmlFor="down"
      >
        <input
          id="down"
          className="super-input"
          inputMode="numeric"
          required
          value={down}
          onChange={(e) => setDown(e.target.value.replace(/[^\d]/g, ""))}
        />
      </Field>

      {purpose === "cash_out_refinance" && (
        <Field className="mt-5" label="How much cash do you want to take out?" htmlFor="cashout">
          <input
            id="cashout"
            className="super-input"
            inputMode="numeric"
            value={cashOut}
            onChange={(e) => setCashOut(e.target.value.replace(/[^\d]/g, ""))}
          />
        </Field>
      )}

      {/* 6 — Income */}
      <Field className="mt-5" label="Roughly, what do you earn a month?" htmlFor="income">
        <input
          id="income"
          className="super-input"
          inputMode="numeric"
          required
          placeholder="Before tax"
          value={income}
          onChange={(e) => setIncome(e.target.value.replace(/[^\d]/g, ""))}
        />
        <Why>
          A rough number is enough — we verify the real one from your bank later. We ask now because
          it lets us tell you straight away if the loan will not work.
        </Why>
      </Field>

      {priceNum > 0 && (
        <div className="mt-6 rounded-md bg-raised px-4 py-3 text-sm text-ink-soft">
          That is a <span className="super-figure text-ink">{money(loanAmount)}</span> loan
          {downPercent > 0 && <> · {downPercent}% down</>}
        </div>
      )}

      {gate && <GateNotice gate={gate} />}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          className="super-btn super-btn-primary"
          disabled={submitting || looking || readOnly}
        >
          {submitting ? "Checking…" : "Continue"}
        </button>
      </div>
      {readOnly && (
        <p className="mt-3 text-sm text-ink-muted">
          This is a sample file, so nothing here can be changed.
        </p>
      )}
    </form>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="super-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * The confirmable summary.
 *
 * Everything here was retrieved. Two different things can be wrong with it,
 * and they need different exits:
 *
 *   - **Wrong address.** Start over. Nothing on the card is salvageable.
 *   - **Right address, wrong details.** The county thinks it is a 2-bed and it
 *     has been a 3-bed since the loft conversion. That is a correction to
 *     record, not a reason to stop.
 *
 * The old card only had the first exit, wired to the word "Edit", so anybody
 * whose bedroom count was stale wiped their address and started again. Now the
 * correction is captured, acknowledged, and sent for review while the borrower
 * carries on. Nothing they type here reaches the engine — see the route.
 */
function PropertyCard({
  lookup,
  correction,
  onCorrect,
  onWrongAddress,
}: {
  lookup: Lookup;
  correction: { note: string; corrections: Record<string, string> } | null;
  onCorrect: (c: { note: string; corrections: Record<string, string> } | null) => void;
  onWrongAddress: () => void;
}) {
  const r = lookup.record;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");

  const facts = [
    TYPE_LABEL[r.propertyType] ?? r.propertyType,
    `${r.bedrooms} bed`,
    `${r.bathrooms} bath`,
    `${r.squareFeet.toLocaleString()} sq ft`,
    `built ${r.yearBuilt}`,
  ];

  const FIELDS: { key: string; label: string; current: string }[] = [
    { key: "bedrooms", label: "Bedrooms", current: String(r.bedrooms) },
    { key: "bathrooms", label: "Bathrooms", current: String(r.bathrooms) },
    { key: "squareFeet", label: "Square feet", current: String(r.squareFeet) },
    { key: "yearBuilt", label: "Year built", current: String(r.yearBuilt) },
  ];

  function submitCorrection() {
    const changed = Object.fromEntries(
      Object.entries(draft).filter(
        ([k, v]) => v.trim() !== "" && v !== FIELDS.find((f) => f.key === k)?.current,
      ),
    );
    if (Object.keys(changed).length === 0 && !note.trim()) {
      setOpen(false);
      return;
    }
    onCorrect({ note: note.trim(), corrections: changed });
    setOpen(false);
  }

  return (
    <div className="super-notice super-notice-ok mt-5">
      <p className="text-sm font-medium text-ink">
        {r.county} County · APN {r.apn}
      </p>
      <p className="mt-1 text-sm text-ink-soft">{facts.join(" · ")}</p>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-soft">
        <Fact label="Assessed" value={money(r.assessedValue)} />
        <Fact label="Property tax" value={`${money(r.annualPropertyTax)}/yr`} />
        <Fact label="Flood zone" value={lookup.flood.zone} />
        {r.hoaExists && r.monthlyAssociationDues !== undefined && (
          <Fact label="HOA" value={`${money(r.monthlyAssociationDues)}/mo`} />
        )}
      </dl>

      {lookup.flood.insuranceRequired && (
        <p className="mt-3 text-sm text-ink-soft">
          This one sits in a flood zone, so flood insurance will be required. Worth knowing now
          rather than at closing.
        </p>
      )}

      {correction ? (
        <div className="mt-3 border-t border-ok/30 pt-3">
          <p className="text-sm text-ink-soft">
            Thanks — we have your correction and someone will check it against the county record. It
            will not hold anything up, so carry on.
          </p>
          <button
            type="button"
            onClick={() => onCorrect(null)}
            className="super-link-quiet mt-1.5 text-sm"
          >
            Undo
          </button>
        </div>
      ) : open ? (
        <div className="mt-3 border-t border-ok/30 pt-3">
          <p className="text-sm text-ink-soft">
            Tell us what is off. We will check it — you do not need to wait.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="flex items-center gap-3">
                <label className="w-28 shrink-0 text-sm text-ink-soft" htmlFor={`c-${f.key}`}>
                  {f.label}
                </label>
                <input
                  id={`c-${f.key}`}
                  className="super-input"
                  placeholder={f.current}
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <textarea
              className="super-input mt-1"
              rows={2}
              placeholder="Anything else we should know about it?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className="super-btn super-btn-outline"
              onClick={submitCorrection}
            >
              Send correction
            </button>
            <button
              type="button"
              className="super-link-quiet text-sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" onClick={() => setOpen(true)} className="super-link-quiet text-sm">
            Something here is wrong
          </button>
          <button type="button" onClick={onWrongAddress} className="super-link-quiet text-sm">
            This is not my property
          </button>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline text-ink-soft">{label} </dt>
      <dd className="super-figure inline text-ink">{value}</dd>
    </div>
  );
}

/**
 * The stop.
 *
 * Phrased as a structural fact about the numbers, not a judgement about the
 * person, and it always names the lever — a bigger down payment, a different
 * price. A gate that only says no teaches somebody to abandon.
 */
function GateNotice({ gate }: { gate: Affordability }) {
  return (
    <div className="super-notice mt-6">
      <p className="font-display text-base text-ink">These numbers do not work yet</p>
      <ul className="mt-2 flex flex-col gap-1.5 text-base text-ink-soft">
        {gate.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-ink-muted">
        We have not checked your credit and nothing has been recorded. Adjust the numbers above and
        try again.
      </p>
    </div>
  );
}
