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
 * Demographics are deliberately NOT here. They belong on the review screen,
 * and only when the occupancy makes them lawful to collect.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { useLoanFile, type LoanFileView } from "../lib/file.js";
import { primaryBorrower } from "../lib/borrowers.js";
import { PERSONA_READ_ONLY, useAuth } from "../lib/auth.js";
import { Why } from "../components/Why.js";
import { clearDraft, readDraft, saveDraft } from "../lib/identity.js";
import { calendarDate } from "../lib/ledger.js";
import { SAMPLE_FILE_START_YOUR_OWN } from "../lib/home-copy.js";
import { Working } from "../components/Working.js";
import { creditCheckCopy, identityCheckCopy, modeOf, ssnDisclosure } from "../lib/disclosures.js";
import { WAITING_COPY } from "../lib/outcomes.js";

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

/**
 * What screen 2 already knows about the person, when they come back to it.
 *
 * This screen never read the file. That was survivable while the only way
 * back onto it was the repair path, which exists precisely because the person
 * would not read; it stopped being survivable when the stepper's dots became
 * links, because a borrower going back to correct a phone number met an empty
 * form that will not submit without scanning a document again and retyping a
 * Social Security number. The server has never asked for either on a revisit —
 * `identitySchema` makes the vault handle optional and says why — so the
 * screen was the only part demanding them.
 *
 * The facts come off the file rather than the scan because they are what the
 * scan already established and what the file already holds.
 */
export function revisitFrom(file: Pick<LoanFileView, "borrowers"> | undefined): {
  identity: Identity;
  phone: string;
  citizenship: string;
  maritalStatus: string;
} | null {
  // The person signed in, never "whoever is first". Screen 2 is about the
  // applicant, and a file that has since gained a co-borrower still resumes
  // this screen for the person whose request it is.
  const who = primaryBorrower(file);
  if (!who) return null;
  return {
    identity: {
      firstName: who.firstName,
      lastName: who.lastName,
      dateOfBirth: who.dateOfBirth,
      address: who.currentAddress,
    },
    phone: who.phone,
    citizenship: who.citizenship ?? "us_citizen",
    maritalStatus: who.maritalStatus,
  };
}

/**
 * Whether this screen still has to ask for a Social Security number.
 *
 * Once one is on record the answer is no, and asking anyway is how people are
 * trained to type their SSN into whatever asks for it. The submit already
 * sends no vault handle for a blank field, and the server already accepts a
 * revisit without one; a `required` attribute was all that stood in the way.
 */
export function ssnRequired(file: Pick<LoanFileView, "borrowers"> | undefined): boolean {
  return !primaryBorrower(file)?.ssn.last4;
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

  /** Only used when the vendor's verified outputs carry no date of birth. */
  const [dobInput, setDobInput] = useState("");

  /*
   * The person they are applying with, if there is one: a name, an email and
   * whether they will live in the home. Nothing else is asked about them
   * here, because nothing else is the applicant's to say — the co-borrower
   * completes their own profile in their own session. Somebody already named
   * is read back off the file instead of being asked for again.
   */
  const [withSomeone, setWithSomeone] = useState(false);
  const [coFirstName, setCoFirstName] = useState("");
  const [coLastName, setCoLastName] = useState("");
  const [coEmail, setCoEmail] = useState("");
  const [coLivesHere, setCoLivesHere] = useState(true);
  const named = data?.file.invitedBorrowers ?? [];
  const coBorrowerFilled = Boolean(coFirstName.trim() && coLastName.trim() && coEmail.trim());

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = fileId ? readDraft(fileId) : null;

  /*
   * Seeded once, and only when this is a plain return to the screen.
   *
   * Once, because "Not you? Scan again" clears `identity` and a seed that
   * watched it would put it straight back. Not while a draft is sitting there,
   * because a draft means the borrower is mid-round-trip through the identity
   * vendor and the effect below is waiting to write what the vendor actually
   * read — the file's older facts must not get in front of it.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || draft) return;
    const known = revisitFrom(data?.file);
    if (!known) return;
    seeded.current = true;
    setIdentity(known.identity);
    setPhone((current) => current || known.phone);
    setCitizenship(known.citizenship);
    setMaritalStatus(known.maritalStatus);
    // `draft` is read once at mount, like the return effect below; re-running
    // on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.file]);

  /*
   * Screen 1 hands the income over on router state, which a redirect to the
   * identity vendor destroys along with everything else. The draft carries it.
   */
  const statedIncome =
    Number((location.state as { income?: number } | null)?.income ?? 0) ||
    (draft?.statedIncome ?? 0);

  /*
   * What this screen may say about the two things it starts.
   *
   * Both come off `connectorModes`, which is the server reading its own
   * registry — so the button that leaves the site, the warning about test
   * mode, and the note under the credit animation are three readings of one
   * fact rather than three guesses.
   */
  const identityCopy = identityCheckCopy(modeOf(authConfig?.connectorModes, "identity"));
  const creditCopy = creditCheckCopy(modeOf(authConfig?.connectorModes, "credit"));

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
    if (withSomeone && named.length === 0 && !coBorrowerFilled) {
      setError(WAITING_COPY.incomplete);
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
        // No housing basis, because this screen does not ask for one.
        //
        // It used to send the literal "rent" — an assertion nobody made, on a
        // screen with no such question — because the server required the
        // field. The field is nullable now, `du_residences` is where the real
        // answer goes, and an unasked question is sent as nothing at all.

        // The review screen collects these, when occupancy makes it lawful.
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

      // The person they are applying with, named and nothing more. Once: a
      // revisit with somebody already named reads them back above instead of
      // naming them again, and the box is not offered.
      if (withSomeone && named.length === 0 && coBorrowerFilled) {
        await api.post(`/files/${fileId}/co-borrowers`, {
          firstName: coFirstName.trim(),
          lastName: coLastName.trim(),
          email: coEmail.trim(),
          occupiesProperty: coLivesHere,
        });
      }

      const file = await api.get<{ file: LoanFileView }>(`/files/${fileId}`);
      // The authorization is the applicant's own. It is read back off the file
      // rather than off this form because the row is the server's answer to
      // the save above, and a co-borrower on the file is not who just signed
      // this screen.
      const borrowerId = primaryBorrower(file.file)?.id;
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

      // Screen 3, which is the next step and not a branch. The stepper only
      // goes backwards, so this call is the ONLY way a borrower reaches the
      // declarations — sending them to the bank screen left Section 5 unasked
      // forever and the signature on screen 5 with nothing to attest to.
      //
      // No interstitial for the credit result either. That was a screen whose
      // entire content was a number and a Continue button, which is a step the
      // borrower pays for and we get nothing from. It is now a bar at the top
      // of the bank screen — same reassurance, no extra click.
      navigate(`/f/${fileId}/declarations`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY") {
        setError(SAMPLE_FILE_START_YOUR_OWN);
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

  /** Take a named person off, while that is still the applicant's to do. */
  async function removeNamed(borrowerId: string) {
    setError(null);
    try {
      await api.del(`/files/${fileId}/co-borrowers/${borrowerId}`);
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove them. Try again.");
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
              to prevent. Whether there is anything to say is
              `identityCheckCopy`'s to decide: test mode is the sandbox, and a
              live key verifying a real document would make this sentence the
              false one.
            */}
            {identityCopy.caveat && (
              <div className="super-notice super-notice-warn mb-4">
                <p className="text-sm text-ink-soft">{identityCopy.caveat}</p>
              </div>
            )}
            <button
              type="button"
              className="super-btn super-btn-primary"
              onClick={() => void scan()}
              disabled={readOnly}
            >
              {/*
                Named, because pressing it leaves our site. A button reading
                "Scan your ID and take a selfie" that instead navigates to a
                Stripe domain asking for a government ID looks exactly like
                the thing people are told to be suspicious of — so which of
                the two it says is a function of the identity connector's
                mode, in `identityCheckCopy`.
              */}
              {identityCopy.button}
            </button>
            <Why>
              We have to confirm you are who you say you are before we can pull anything. The check
              also saves you typing your name, date of birth and address.
              {identityCopy.vendorNote}
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
          required={ssnRequired(data?.file)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="000-00-0000"
          value={ssn}
          onChange={(e) => setSsn(formatSsn(e.target.value))}
        />
        <Why>{ssnDisclosure()}</Why>
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
      {/* 4 — Applying with someone? A name and an email, and the file waits
          on them. Their date of birth, their address and their number are
          theirs to state, on a screen of their own. */}
      <div className="mt-7 border-t border-rule-soft pt-6">
        {named.length > 0 ? (
          <>
            <p className="text-base text-ink">
              {WAITING_COPY.applyingWithNamed(
                named.map((who) => `${who.firstName} ${who.lastName}`),
              )}
            </p>
            {named.map((who) => (
              <p key={who.id} className="mt-1 text-sm text-ink-soft">
                {who.email}
                {" · "}
                <button
                  type="button"
                  className="super-link-quiet"
                  onClick={() => void removeNamed(who.id)}
                  disabled={readOnly || running}
                >
                  Remove
                </button>
              </p>
            ))}
            <p className="mt-2 text-xs text-ink-faint">{WAITING_COPY.noEmailYet}</p>
          </>
        ) : (
          <>
            <label className="flex items-start gap-3 text-base text-ink-soft">
              <input
                type="checkbox"
                className="mt-1"
                checked={withSomeone}
                onChange={(e) => setWithSomeone(e.target.checked)}
                disabled={readOnly}
              />
              <span>{WAITING_COPY.applyingWith}</span>
            </label>
            {withSomeone && (
              <div className="mt-3 flex flex-col gap-3">
                <p className="text-sm text-ink-muted">{WAITING_COPY.applyingWithHelp}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm text-ink-soft">
                    Their first name
                    <input
                      className="super-input mt-1"
                      autoComplete="off"
                      value={coFirstName}
                      onChange={(e) => setCoFirstName(e.target.value)}
                    />
                  </label>
                  <label className="block text-sm text-ink-soft">
                    Their last name
                    <input
                      className="super-input mt-1"
                      autoComplete="off"
                      value={coLastName}
                      onChange={(e) => setCoLastName(e.target.value)}
                    />
                  </label>
                </div>
                <label className="block text-sm text-ink-soft">
                  Their email
                  <input
                    className="super-input mt-1"
                    type="email"
                    autoComplete="off"
                    value={coEmail}
                    onChange={(e) => setCoEmail(e.target.value)}
                  />
                </label>
                <label className="flex items-start gap-3 text-base text-ink-soft">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={coLivesHere}
                    onChange={(e) => setCoLivesHere(e.target.checked)}
                  />
                  <span>{WAITING_COPY.livesHere}</span>
                </label>
              </div>
            )}
          </>
        )}
      </div>

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
      </div>

      {running && (
        <Working
          steps={[
            { label: creditCopy.step, ms: 1400 },
            { label: "Running required screening", ms: 1200 },
            { label: "Searching the property records", ms: 1600 },
          ]}
          note={creditCopy.note}
        />
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      <button
        className="super-btn super-btn-primary mt-7"
        disabled={running || !authorized || !identity || readOnly}
      >
        {running ? "Working…" : "Continue"}
      </button>
      {!identity && <p className="mt-2 text-xs text-ink-faint">{identityCopy.prompt}</p>}
    </form>
  );
}
