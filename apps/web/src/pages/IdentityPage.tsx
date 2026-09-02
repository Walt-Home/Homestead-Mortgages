/**
 * Screen 2 — identity and credit.
 *
 * Seven items, and nothing between the SSN and the pull firing. The old screen
 * asked for eleven fields including name, date of birth and current address;
 * those three now come off the scanned document, which is both faster and more
 * accurate than asking somebody to type their own legal name.
 *
 * Submitting fires three calls: the soft tri-merge, OFAC screening, and an
 * ownership-and-encumbrance search against the APN screen 1 retrieved. All
 * three run after the authorization consent is written, which is what makes
 * them legal to run at all.
 *
 * Demographics are deliberately NOT here. They belong on screen 4, and only
 * when the occupancy makes them lawful to collect.
 */

import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { hasConsent, useLoanFile } from "../lib/file.js";
import { useAuth } from "../lib/auth.js";
import { Why } from "../components/Why.js";
import { Working } from "../components/Working.js";

interface Identity {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  documentType: string;
  address: { line1: string; line2?: string; city: string; state: string; postalCode: string };
}

interface CreditResult {
  report: {
    scores: { bureau: string; score: number; model: string }[];
    tradelines: unknown[];
  };
}

/**
 * Hyphenate as they type, in the shape the placeholder promised.
 *
 * Both fields show a formatted placeholder, so both have to accept a formatted
 * value — a field that shows `000-00-0000` and then keeps whatever raw string
 * you paste has lied about what it wants. Digits are extracted, capped, and
 * regrouped on every keystroke, which also means a pasted "(512) 555-0142" or
 * "512.555.0142" lands correctly instead of failing validation later.
 */
function group(digits: string, sizes: number[]): string {
  const out: string[] = [];
  let i = 0;
  for (const size of sizes) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + size));
    i += size;
  }
  return out.join("-");
}

/** 123456789 → 123-45-6789 */
function formatSsn(input: string): string {
  return group(input.replace(/\D/g, "").slice(0, 9), [3, 2, 4]);
}

/** 5125550142 → 512-555-0142 */
function formatPhone(input: string): string {
  return group(input.replace(/\D/g, "").slice(0, 10), [3, 3, 4]);
}

export function IdentityPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const { user } = useAuth();
  const readOnly = data?.file.isDemo === true;

  // They signed in to get here, so we already have this. Asking again is asking
  // somebody to prove they are the person we just authenticated.
  const email = user?.email ?? "";

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [scanning, setScanning] = useState(false);

  const [ssn, setSsn] = useState("");
  const [phone, setPhone] = useState("");
  const [citizenship, setCitizenship] = useState("us_citizen");
  const [maritalStatus, setMaritalStatus] = useState("unmarried");
  const [authorized, setAuthorized] = useState(false);
  const [econsent, setEconsent] = useState(true);
  const [smsConsent, setSmsConsent] = useState(true);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statedIncome = Number((location.state as { income?: number } | null)?.income ?? 0);

  async function scan() {
    if (!fileId) return;
    setScanning(true);
    setError(null);
    try {
      const res = await api.post<{ identity: Identity }>(`/files/${fileId}/identity-check`, {});
      setIdentity(res.identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That scan did not go through.");
    } finally {
      setScanning(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fileId || !identity) return;
    setRunning(true);
    setError(null);

    try {
      const digits = ssn.replace(/\D/g, "");
      await api.post(`/files/${fileId}/borrowers`, {
        firstName: identity.firstName,
        lastName: identity.lastName,
        dateOfBirth: identity.dateOfBirth,
        currentAddress: {
          line1: identity.address.line1,
          city: identity.address.city,
          state: identity.address.state.toUpperCase(),
          postalCode: identity.address.postalCode,
        },
        email,
        phone,
        maritalStatus,
        citizenship,
        preferredLanguage: "en",
        ...(digits.length >= 4
          ? {
              ssnVaultHandle: `vault:${digits.slice(-4)}:${crypto.randomUUID()}`,
              ssnLast4: digits.slice(-4),
            }
          : {}),
        // Derived from the county record rather than asked — screen 1 already
        // retrieved whether this borrower held an ownership interest.
        firstTimeHomebuyer: data?.file.propertyRecord
          ? !data.file.propertyRecord.priorOwnershipInLastThreeYears
          : true,
        // KNOWN GAP, not a derivation.
        //
        // The four-screen flow does not ask whether the borrower rents or
        // owns, and no retrieval establishes it either. The server schema
        // requires the field, so this sends "rent" — which is an assertion
        // nobody made, and the one place in the rebuilt flow where that is
        // still true.
        //
        // The honest fix is one of: ask it as an eighth item on this screen,
        // derive it from `assets.identifiedRentPayments` after the bank
        // connection (present for a renter, absent for an owner — but absent
        // is also what a cash-paying renter looks like), or make the field
        // nullable so "we did not ask" is representable. The third is right
        // and touches the requirements engine, which this rebuild does not.
        currentHousing: "rent",
        // Screen 4 collects these, and only when occupancy makes it lawful.
        demographics: null,
        statedMonthlyIncome: statedIncome || 1,
      });

      const file = await api.get<{ file: { borrowers: { id: string }[] } }>(`/files/${fileId}`);
      const borrowerId = file.file.borrowers[0]?.id;
      if (borrowerId) {
        if (!hasConsent(data?.file, "verification_authorization")) {
          await api.post(`/files/${fileId}/consents`, {
            kind: "verification_authorization",
            borrowerId,
          });
        }
        if (econsent && !hasConsent(data?.file, "econsent")) {
          await api.post(`/files/${fileId}/consents`, { kind: "econsent", borrowerId });
        }
        if (smsConsent && !hasConsent(data?.file, "sms_contact")) {
          await api.post(`/files/${fileId}/consents`, { kind: "sms_contact", borrowerId });
        }
      }

      // The three calls. Credit first because it is the one the borrower is
      // waiting to see; screening and the lien search are ours.
      await api.post<CreditResult>(`/files/${fileId}/credit`, {});

      await api.post(`/files/${fileId}/screening`, {}).catch(() => undefined);
      const apn = data?.file.propertyRecord?.apn;
      if (apn) {
        await api.post(`/files/${fileId}/liens`, { apn }).catch(() => undefined);
      }

      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });

      // No interstitial. The credit result was a screen whose entire content
      // was a number and a Continue button, which is a step the borrower pays
      // for and we get nothing from. It is now a bar at the top of the bank
      // screen — same reassurance, no extra click.
      navigate(`/f/${fileId}/bank`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY") {
        setError("This is a sample file, so it is read-only. Start your own to walk the flow.");
      } else {
        setError(err instanceof Error ? err.message : "Something did not go through.");
      }
    } finally {
      setRunning(false);
    }
  }

  /* ── The form ─────────────────────────────────────────────────────────── */

  return (
    <form onSubmit={submit} className="card">
      <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
        Now, about you
      </h1>
      <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
        Your ID gives us your name, date of birth and address, so you do not have to type them.
      </p>

      {/* 1 — ID scan and selfie */}
      <div className="mt-7">
        {identity ? (
          <div className="rounded-row border border-olive-border bg-olive-light p-4">
            <p className="text-[14px] font-medium text-ink-editorial">
              {identity.firstName} {identity.lastName}
            </p>
            <p className="mt-1 text-[13px] text-ink-soft">
              Born {identity.dateOfBirth} · {identity.address.line1}, {identity.address.city}{" "}
              {identity.address.state}
            </p>
            <button
              type="button"
              onClick={() => setIdentity(null)}
              className="mt-2 text-[13px] text-olive underline underline-offset-2"
            >
              Not you? Scan again
            </button>
          </div>
        ) : scanning ? (
          <Working
            steps={[
              { label: "Reading your document", ms: 1100 },
              { label: "Checking it is genuine", ms: 1100 },
              { label: "Matching your selfie", ms: 1400 },
            ]}
            note="Hold steady — this is the slowest part of the whole thing."
          />
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void scan()}
              disabled={readOnly}
            >
              Scan your ID and take a selfie
            </button>
            <Why>
              We have to confirm you are who you say you are before we can pull anything. The scan
              also saves you typing your name, date of birth and address.
            </Why>
          </>
        )}
      </div>

      {/* 2 — SSN */}
      <div className="mt-6">
        <label className="field-label" htmlFor="ssn">
          Social security number
        </label>
        <input
          id="ssn"
          className="field-input"
          required
          inputMode="numeric"
          autoComplete="off"
          placeholder="000-00-0000"
          value={ssn}
          onChange={(e) => setSsn(formatSsn(e.target.value))}
        />
        <Why>
          It is the only way to pull your credit. We keep the last four digits; the rest goes
          straight to the credit bureaus and is never stored here.
        </Why>
      </div>

      {/* 3 — Phone. Email comes from the account they signed in with. */}
      <div className="mt-5">
        <label className="field-label" htmlFor="phone">
          Phone
        </label>
        <input
          id="phone"
          type="tel"
          required
          inputMode="numeric"
          placeholder="000-000-0000"
          className="field-input"
          value={phone}
          onChange={(e) => setPhone(formatPhone(e.target.value))}
        />
        <p className="mt-1.5 text-[12px] text-meta">
          We will use {email || "the email on your account"} for everything in writing.
        </p>
      </div>

      {/* 4 — Citizenship */}
      <div className="mt-5">
        <label className="field-label" htmlFor="citizenship">
          Citizenship
        </label>
        <select
          id="citizenship"
          className="field-input"
          value={citizenship}
          onChange={(e) => setCitizenship(e.target.value)}
        >
          <option value="us_citizen">U.S. citizen</option>
          <option value="permanent_resident">Permanent resident</option>
          <option value="non_permanent_resident">Non-permanent resident</option>
        </select>
      </div>

      {/* 5 — Marital status */}
      <div className="mt-5">
        <label className="field-label" htmlFor="marital">
          Marital status
        </label>
        <select
          id="marital"
          className="field-input"
          value={maritalStatus}
          onChange={(e) => setMaritalStatus(e.target.value)}
        >
          <option value="unmarried">Unmarried</option>
          <option value="married">Married</option>
          <option value="separated">Separated</option>
        </select>
      </div>

      {/* 6 & 7 — The two consents */}
      <div className="mt-7 flex flex-col gap-3 border-t border-line-light pt-6">
        <label className="flex items-start gap-3 text-[15px] leading-relaxed text-ink-prose">
          <input
            type="checkbox"
            className="mt-1"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
          />
          <span>Authorize verification of my credit, employment, income and assets</span>
        </label>
        <label className="flex items-start gap-3 text-[15px] leading-relaxed text-ink-prose">
          <input
            type="checkbox"
            className="mt-1"
            checked={econsent}
            onChange={(e) => setEconsent(e.target.checked)}
          />
          <span>Agree to receive disclosures electronically</span>
        </label>
        <label className="flex items-start gap-3 text-[15px] leading-relaxed text-ink-prose">
          <input
            type="checkbox"
            className="mt-1"
            checked={smsConsent}
            onChange={(e) => setSmsConsent(e.target.checked)}
          />
          <span>
            Text me updates about my application
            <span className="block text-[13px] text-meta">
              Optional, and separate from the disclosures above. Reply STOP any time.
            </span>
          </span>
        </label>
      </div>

      {running && (
        <Working
          steps={[
            { label: "Checking your credit", ms: 1400 },
            { label: "Running required screening", ms: 1200 },
            { label: "Searching the property records", ms: 1600 },
          ]}
          note="A soft pull. This does not affect your score."
        />
      )}

      {error && <p className="mt-4 text-[13px] text-error">{error}</p>}

      <button
        className="btn-primary mt-7"
        disabled={running || !authorized || !identity || readOnly}
      >
        {running ? "Working…" : "Continue"}
      </button>
      {!identity && <p className="mt-2 text-[12px] text-subtle">Scan your ID to continue.</p>}
    </form>
  );
}
