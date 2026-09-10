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

import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";
import { PERSONA_READ_ONLY, useAuth } from "../lib/auth.js";
import { Why } from "../components/Why.js";
import { clearDraft, readDraft, saveDraft } from "../lib/identity.js";
import { calendarDate } from "../lib/ledger.js";
import { Working } from "../components/Working.js";

interface DocumentRead {
  requiresRedirect?: boolean;
  verificationUrl?: string;
  documentName: string | null;
  documentDateOfBirth: string | null;
  documentAddress: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
  } | null;
}

interface Identity {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
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

/**
 * What to check when the save did not take.
 *
 * The server refuses to read a person back whose required facts are missing
 * or blank, and its message names a borrower id and a fact predicate — ours
 * to read, nobody else's. The borrower gets the field instead, in the words
 * this screen uses for it: three come off the scanned ID, one off the account
 * they signed in with, and the rest are typed here.
 */
const CHECK_FOR: Record<string, string> = {
  legal_name: "the name on your ID",
  date_of_birth: "your date of birth",
  current_address: "the address on your ID",
  ssn_token: "your social security number",
  email: "the email on your account",
  phone: "your phone number",
  citizenship: "your citizenship",
  marital_status: "your marital status",
};

export function repairMessage(predicate: string | undefined): string {
  const field = predicate === undefined ? undefined : CHECK_FOR[predicate];
  return field
    ? `Something about ${field} did not go through. Please check it and try again.`
    : "Something in your details did not go through. Please check them and try again.";
}

export function IdentityPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const { user, config: authConfig } = useAuth();
  const readOnly = data?.file.isDemo === true;

  // They signed in to get here, so we already have this. Asking again is asking
  // somebody to prove they are the person we just authenticated.
  const email = user?.email ?? "";

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [scanning, setScanning] = useState(false);

  // Deliberately NOT seeded from the draft: the SSN is never written to
  // browser storage, so it is retyped after a redirect.
  const [ssn, setSsn] = useState("");
  const [phone, setPhone] = useState(() => (fileId ? (readDraft(fileId)?.phone ?? "") : ""));
  const [citizenship, setCitizenship] = useState(
    () => (fileId ? readDraft(fileId)?.citizenship : null) ?? "us_citizen",
  );
  const [maritalStatus, setMaritalStatus] = useState(
    () => (fileId ? readDraft(fileId)?.maritalStatus : null) ?? "unmarried",
  );
  const [authorized, setAuthorized] = useState(
    () => (fileId ? readDraft(fileId)?.authorized : null) ?? false,
  );
  const [econsent, setEconsent] = useState(
    () => (fileId ? readDraft(fileId)?.econsent : null) ?? true,
  );
  const [smsConsent, setSmsConsent] = useState(
    () => (fileId ? readDraft(fileId)?.smsConsent : null) ?? true,
  );

  /** Only used when the vendor's verified outputs carry no date of birth. */
  const [dobInput, setDobInput] = useState("");

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = fileId ? readDraft(fileId) : null;

  /*
   * Screen 1 hands the income over on router state, which a redirect to the
   * identity vendor destroys along with everything else. The draft carries it.
   */
  const statedIncome =
    Number((location.state as { income?: number } | null)?.income ?? 0) ||
    (draft?.statedIncome ?? 0);

  /** Whether pressing the button leaves this site. */
  const identityRedirects = authConfig?.identityRequiresRedirect === true;

  /*
   * Coming back from the vendor.
   *
   * The redirect destroyed the component that started the check, so nothing on
   * this screen knows it happened — without this the borrower returns to the
   * same button they already pressed and is asked to verify a second time.
   *
   * A saved draft is the signal: it is only written immediately before the
   * redirect. If the check has not finished yet, the answer is "pending" and
   * `identity` simply stays null, which is the state the screen already knows
   * how to render.
   */
  useEffect(() => {
    if (!fileId || identity || !draft) return;
    let cancelled = false;
    void api
      .post<DocumentRead & { status?: string }>(`/files/${fileId}/identity-document/complete`, {})
      .then((doc) => {
        if (cancelled || doc.status !== "verified") return;
        const [firstName, ...rest] = (doc.documentName ?? "").split(" ");
        // A date of birth is NOT required here. Stripe's verified outputs
        // carry name and address and, depending on the document, no dob at
        // all — its own test identity has none. Refusing the whole result
        // over one absent field would strand a borrower whose ID genuinely
        // verified; the screen asks for the date instead.
        if (!firstName || !doc.documentAddress) return;
        setIdentity({
          firstName,
          lastName: rest.join(" "),
          dateOfBirth: doc.documentDateOfBirth ?? "",
          address: doc.documentAddress,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `draft` is read once at mount; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, identity]);

  async function scan() {
    if (!fileId) return;
    setScanning(true);
    setError(null);
    try {
      const doc = await api.post<DocumentRead>(`/files/${fileId}/identity-document`, {});

      /*
       * A hosted vendor cannot read the document here — it takes the borrower
       * to its own site and answers later. Everything typed so far is saved
       * first, because the redirect replaces this document and would otherwise
       * wipe the form.
       */
      if (doc.requiresRedirect && doc.verificationUrl) {
        saveDraft(fileId, {
          phone,
          citizenship,
          maritalStatus,
          authorized,
          econsent,
          smsConsent,
          statedIncome,
        });
        window.location.assign(doc.verificationUrl);
        return;
      }

      const [firstName, ...rest] = (doc.documentName ?? "").split(" ");
      if (!firstName || !doc.documentAddress) {
        throw new Error("That document was missing something we need.");
      }
      setIdentity({
        firstName,
        lastName: rest.join(" "),
        // See the note in the return effect: absent is normal, and asked for.
        dateOfBirth: doc.documentDateOfBirth ?? "",
        address: doc.documentAddress,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That scan did not go through.");
    } finally {
      setScanning(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fileId || !identity) return;
    if (!identity.dateOfBirth && !dobInput) {
      setError("We need your date of birth — your ID did not carry one.");
      return;
    }
    setRunning(true);
    setError(null);

    try {
      const digits = ssn.replace(/\D/g, "");
      await api.post(`/files/${fileId}/borrowers`, {
        firstName: identity.firstName,
        lastName: identity.lastName,
        dateOfBirth: identity.dateOfBirth || dobInput,
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
        // On the repair path the file never loaded, so there is no record
        // to derive from; null asserts nothing and the earlier fact stands.
        firstTimeHomebuyer: data?.file
          ? data.file.propertyRecord
            ? !data.file.propertyRecord.priorOwnershipInLastThreeYears
            : true
          : null,
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
        // Omitted, not faked, when this screen does not have it.
        //
        // The figure is stated on screen 1 and asserted there as a fact about
        // the person; it reaches here only on router state or a saved draft,
        // and a redirect through the identity vendor destroys both. Sending a
        // placeholder wrote an income of one dollar about a real borrower and
        // let the receipt count it as one of the six pieces. Absent asserts
        // nothing, and the figure screen 1 recorded stands.
        ...(statedIncome > 0 ? { statedMonthlyIncome: statedIncome } : {}),
      });

      const file = await api.get<{ file: { borrowers: { id: string }[] } }>(`/files/${fileId}`);
      const borrowerId = file.file.borrowers[0]?.id;
      if (borrowerId) {
        // Always posted, never skipped on what the file already shows.
        //
        // This used to check the file's consent rows first and post nothing
        // when one was there. But a row on the file is not the same thing as
        // a live grant on the person: the grant expires after 120 days and the
        // file's row never learns that, so the check said "already authorized"
        // to exactly the borrower who had to sign again. The server holds the
        // whole rule — a grant that is still live absorbs the duplicate, a
        // lapsed one is renewed — and the client no longer decides.
        await api.post(`/files/${fileId}/consents`, {
          kind: "verification_authorization",
          borrowerId,
        });
        if (econsent) {
          await api.post(`/files/${fileId}/consents`, { kind: "econsent", borrowerId });
        }
        if (smsConsent) {
          await api.post(`/files/${fileId}/consents`, { kind: "sms_contact", borrowerId });
        }
      }

      if (borrowerId) {
        // Now that a borrower row exists, record the verification against it.
        // The scan above only read the document to save them typing.
        //
        // Two shapes, and the server says which rather than the client
        // guessing. A fixture verifies in place. A hosted vendor sends the
        // borrower to its own site and returns them to /identity/return on a
        // fresh page load — which is why everything they typed is saved BEFORE
        // this point rather than after. Losing a filled-in form to a redirect
        // is the classic way this breaks.
        const session = await api
          .post<{
            alreadyVerified: boolean;
            requiresRedirect?: boolean;
            verificationId?: string;
            verificationUrl?: string;
          }>(`/files/${fileId}/identity-verification`, { borrowerId })
          .catch(() => null);

        if (
          session &&
          !session.alreadyVerified &&
          session.requiresRedirect &&
          session.verificationUrl
        ) {
          // Leaves the app entirely, so nothing below runs. The credit pull and
          // the rest happen when they land back on the return page.
          window.location.assign(session.verificationUrl);
          return;
        }

        if (session && !session.alreadyVerified && session.verificationId) {
          await api
            .post(`/files/${fileId}/identity-verification/complete`, {
              verificationId: session.verificationId,
            })
            .catch(() => undefined);
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

      if (fileId) clearDraft(fileId);
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
      } else if (err instanceof ApiError && err.code === "PERSONA_READ_ONLY") {
        // The session rather than the file. This screen posts to five routes
        // and any of them can carry it, so without this the one refusal a
        // sample borrower is most likely to meet falls through to the
        // server's own sentence instead of the screen's.
        setError(PERSONA_READ_ONLY);
      } else if (err instanceof ApiError && err.code === "PROJECTION_ERROR") {
        // The save landed but the person still will not read back — this
        // screen IS the repair path, so there is nowhere else to send them.
        // Name the field to look at rather than the server's message.
        setError(repairMessage(err.predicate));
      } else {
        setError(err instanceof Error ? err.message : "Something did not go through.");
      }
    } finally {
      setRunning(false);
    }
  }

  /* ── The form ─────────────────────────────────────────────────────────── */

  return (
    <form onSubmit={submit} className="super-card">
      <h1 className="font-display text-2xl text-ink sm:text-3xl">Now, about you</h1>
      <p className="mt-2 text-base text-ink-soft">
        Your ID gives us your name, date of birth and address, so you do not have to type them.
      </p>

      {/* 1 — ID scan and selfie */}
      <div className="mt-7">
        {identity ? (
          <div className="super-notice super-notice-ok">
            <p className="text-sm font-medium text-ink">
              {identity.firstName} {identity.lastName}
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {identity.dateOfBirth ? `Born ${calendarDate(identity.dateOfBirth)} · ` : ""}
              {identity.address.line1}, {identity.address.city} {identity.address.state}
            </p>
            {/*
              Asked for only when the vendor did not return it.

              Stripe's verified outputs carry name and address and, for many
              documents, no date of birth — so the screen's promise that the
              ID saves you typing holds for everything it actually supplies,
              and the one field it does not is asked for plainly rather than
              guessed at or silently defaulted.
            */}
            {!identity.dateOfBirth && (
              <div className="mt-3">
                <label className="super-label" htmlFor="dob">
                  Date of birth
                </label>
                <input
                  id="dob"
                  type="date"
                  className="super-input"
                  value={dobInput}
                  onChange={(e) => setDobInput(e.target.value)}
                />
                <p className="mt-1 text-xs text-ink-muted">
                  Your ID confirmed your name and address but not your date of birth.
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={() => setIdentity(null)}
              className="super-link-quiet mt-2 text-sm"
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
            {/*
              The one line of the old global prototype banner that survives,
              moved to the only screen where it matters.

              Stripe Identity runs on the sandbox key — config.ts prefers it
              and reaching the live key needs STRIPE_ALLOW_LIVE_IDENTITY. Test
              mode verifies nothing, but it still RECEIVES whatever image is
              put in front of it, into an integration with no retention
              policy. Saying nothing here is an invitation to photograph a
              real driver's licence, which is the outcome the banner existed
              to prevent. Shown only when a hosted vendor is configured; a
              fixture reads nothing.
            */}
            {identityRedirects && (
              <div className="super-notice super-notice-warn mb-4">
                <p className="text-sm text-ink-soft">
                  This check runs in Stripe&rsquo;s test mode, so it cannot verify a real document.
                  Please use Stripe&rsquo;s test credentials rather than your own ID.
                </p>
              </div>
            )}
            <button
              type="button"
              className="super-btn super-btn-primary"
              onClick={() => void scan()}
              disabled={readOnly}
            >
              {/*
                Named, because pressing it leaves our site.
                A button reading "Scan your ID and take a selfie" that instead
                navigates to a Stripe domain asking for a government ID looks
                exactly like the thing people are told to be suspicious of.
              */}
              {identityRedirects ? "Verify your ID with Stripe" : "Scan your ID and take a selfie"}
            </button>
            <Why>
              We have to confirm you are who you say you are before we can pull anything. The check
              also saves you typing your name, date of birth and address.
              {identityRedirects
                ? " Stripe handles it and brings you straight back — we never see your document."
                : ""}
            </Why>
          </>
        )}
      </div>

      {/* 2 — SSN */}
      <div className="mt-6">
        <label className="super-label" htmlFor="ssn">
          Social security number
        </label>
        <input
          id="ssn"
          className="super-input"
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
        <label className="super-label" htmlFor="phone">
          Phone
        </label>
        <input
          id="phone"
          type="tel"
          required
          inputMode="numeric"
          placeholder="000-000-0000"
          className="super-input"
          value={phone}
          onChange={(e) => setPhone(formatPhone(e.target.value))}
        />
        <p className="mt-1.5 text-xs text-ink-muted">
          We will use {email || "the email on your account"} for everything in writing.
        </p>
      </div>

      {/* 4 — Citizenship */}
      <div className="mt-5">
        <label className="super-label" htmlFor="citizenship">
          Citizenship
        </label>
        <select
          id="citizenship"
          className="super-input"
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
        <label className="super-label" htmlFor="marital">
          Marital status
        </label>
        <select
          id="marital"
          className="super-input"
          value={maritalStatus}
          onChange={(e) => setMaritalStatus(e.target.value)}
        >
          <option value="unmarried">Unmarried</option>
          <option value="married">Married</option>
          <option value="separated">Separated</option>
        </select>
      </div>

      {/* 6 & 7 — The two consents */}
      <div className="mt-7 flex flex-col gap-3 border-t border-rule-soft pt-6">
        <label className="flex items-start gap-3 text-base text-ink-soft">
          <input
            type="checkbox"
            className="mt-1"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
          />
          <span>Authorize verification of my credit, employment, income and assets</span>
        </label>
        <label className="flex items-start gap-3 text-base text-ink-soft">
          <input
            type="checkbox"
            className="mt-1"
            checked={econsent}
            onChange={(e) => setEconsent(e.target.checked)}
          />
          <span>Agree to receive disclosures electronically</span>
        </label>
        <label className="flex items-start gap-3 text-base text-ink-soft">
          <input
            type="checkbox"
            className="mt-1"
            checked={smsConsent}
            onChange={(e) => setSmsConsent(e.target.checked)}
          />
          {/*
            The STOP language belongs in the first message, not here. Putting
            it on the checkbox spends three lines of the last screen before a
            credit pull explaining how to undo something the borrower has not
            opted into yet.
          */}
          <span>
            Text me updates about my application <span className="text-ink-muted">(optional)</span>
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

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      <button
        className="super-btn super-btn-primary mt-7"
        disabled={running || !authorized || !identity || readOnly}
      >
        {running ? "Working…" : "Continue"}
      </button>
      {!identity && (
        <p className="mt-2 text-xs text-ink-faint">
          {identityRedirects ? "Verify your ID to continue." : "Scan your ID to continue."}
        </p>
      )}
    </form>
  );
}
