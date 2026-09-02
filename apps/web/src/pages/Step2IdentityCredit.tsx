import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { hasConsent, useLoanFile } from "../lib/file.js";

/**
 * Step 2 — identity and credit, which are one step because they are one act.
 *
 * The borrower tells us who they are, proves it against a document, and
 * authorises us to check. The credit pull then happens as a consequence of the
 * authorisation rather than as a screen of its own: it needs no input, and a
 * screen whose only control is "continue" is a step in the counter and not in
 * the work.
 */
export function Step2IdentityCredit() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const existing = data?.file.borrowers[0];
  const readOnly = data?.file.isDemo === true;

  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phone: "", dateOfBirth: "", ssn: "",
    line1: "", city: "", state: "", postalCode: "",
    citizenship: "us_citizen", maritalStatus: "unmarried",
    currentHousing: "rent", monthlyRent: "", firstTimeHomebuyer: "false",
  });
  const [authorized, setAuthorized] = useState(false);
  const [econsent, setEconsent] = useState(false);
  const [phase, setPhase] = useState<"form" | "verifying" | "pulling" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<number | null>(null);

  useEffect(() => {
    if (!existing) return;
    setForm((f) => ({
      ...f,
      firstName: existing.firstName, lastName: existing.lastName,
      email: existing.email, phone: existing.phone,
      dateOfBirth: existing.dateOfBirth?.slice(0, 10) ?? "",
      line1: existing.currentAddress.line1, city: existing.currentAddress.city,
      state: existing.currentAddress.state, postalCode: existing.currentAddress.postalCode,
      maritalStatus: existing.maritalStatus,
      currentHousing: existing.currentHousing,
      monthlyRent: existing.monthlyRent ? String(existing.monthlyRent) : "",
      firstTimeHomebuyer: String(existing.firstTimeHomebuyer ?? false),
    }));
    setAuthorized(hasConsent(data?.file, "verification_authorization"));
    setEconsent(hasConsent(data?.file, "econsent"));
  }, [existing, data?.file]);

  function set(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const digits = form.ssn.replace(/\D/g, "");
      await api.post(`/files/${fileId}/borrowers`, {
        firstName: form.firstName, lastName: form.lastName,
        email: form.email, phone: form.phone, dateOfBirth: form.dateOfBirth,
        // The full number never leaves the browser; only the last four and an
        // opaque handle are sent.
        ...(digits.length >= 4
          ? { ssnVaultHandle: `vault:${digits.slice(-4)}:${crypto.randomUUID()}`, ssnLast4: digits.slice(-4) }
          : {}),
        currentAddress: {
          line1: form.line1, city: form.city,
          state: form.state.toUpperCase(), postalCode: form.postalCode,
        },
        maritalStatus: form.maritalStatus,
        citizenship: form.citizenship,
        preferredLanguage: "en",
        firstTimeHomebuyer: form.firstTimeHomebuyer === "true",
        currentHousing: form.currentHousing,
        monthlyRent: form.monthlyRent ? Number(form.monthlyRent) : undefined,
        // Demographics are asked in step 4, on the application being signed —
        // not here. Sending nothing is the honest state until then.
        demographics: null,
        statedMonthlyIncome: 1,
      });

      const file = await api.get<{ file: { borrowers: { id: string }[] } }>(`/files/${fileId}`);
      const borrowerId = file.file.borrowers[0]?.id;
      if (borrowerId) {
        if (!hasConsent(data?.file, "verification_authorization")) {
          await api.post(`/files/${fileId}/consents`, { kind: "verification_authorization", borrowerId });
        }
        if (econsent && !hasConsent(data?.file, "econsent")) {
          await api.post(`/files/${fileId}/consents`, { kind: "econsent", borrowerId });
        }
      }

      setPhase("verifying");
      const session = await api.post<{ alreadyVerified: boolean; verificationId?: string }>(
        `/files/${fileId}/identity-verification`, {},
      );
      if (!session.alreadyVerified && session.verificationId) {
        await api.post(`/files/${fileId}/identity-verification/complete`, {
          verificationId: session.verificationId,
        });
      }

      // The credit pull is the consequence of the authorisation, not a step.
      setPhase("pulling");
      const credit = await api.post<{ report?: { scores?: { score: number }[] } }>(
        `/files/${fileId}/credit`,
      );
      const scores = (credit.report?.scores ?? []).map((s) => s.score).sort((a, b) => a - b);
      setScore(scores[1] ?? scores[0] ?? null);

      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
      setPhase("done");
    } catch (err) {
      setPhase("form");
      setError(
        err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY"
          ? "This is a sample file and can't be changed."
          : err instanceof Error
            ? err.message
            : "Something went wrong.",
      );
    }
  }

  if (phase === "done") {
    return (
      <div className="card">
        <div className="mb-4 inline-flex items-center gap-2 rounded-pill bg-olive-light px-3 py-1 text-[12px] font-medium text-olive">
          Verified
        </div>
        <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
          That&rsquo;s the paperwork done
        </h1>
        {score !== null && (
          <div className="mt-5 flex items-baseline gap-3">
            <span className="figure text-[38px] leading-none text-ink-editorial">{score}</span>
            <span className="text-[13px] text-muted">your qualifying credit score</span>
          </div>
        )}
        <p className="mt-4 font-prose text-[16px] leading-relaxed text-ink-prose">
          We checked all three bureaus and confirmed your identity. Nothing here affected your
          score.
        </p>
        <div className="mt-6 flex gap-3">
          <button className="btn-primary" onClick={() => navigate(`/f/${fileId}/bank`)}>
            Continue
          </button>
          <button className="btn-secondary" onClick={() => setPhase("form")}>
            Edit my details
          </button>
        </div>
      </div>
    );
  }

  const busy = phase !== "form";

  return (
    <form className="card" onSubmit={submit}>
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">About you</h1>
      <p className="mt-2 text-[14px] text-muted">
        We need this before we can check anything on your behalf.
      </p>

      <div className="mt-6 grid gap-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">First name</label>
            <input className="field-input" value={form.firstName} onChange={set("firstName")} required />
          </div>
          <div>
            <label className="field-label">Last name</label>
            <input className="field-input" value={form.lastName} onChange={set("lastName")} required />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">Email</label>
            <input className="field-input" type="email" value={form.email} onChange={set("email")} required />
          </div>
          <div>
            <label className="field-label">Phone</label>
            <input className="field-input" value={form.phone} onChange={set("phone")} required />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">Date of birth</label>
            <input className="field-input" type="date" value={form.dateOfBirth} onChange={set("dateOfBirth")} required />
          </div>
          <div>
            <label className="field-label">Social Security number</label>
            <input
              className="field-input figure"
              value={form.ssn}
              onChange={set("ssn")}
              placeholder={existing ? `•••-••-${existing.ssn.last4}` : "000-00-0000"}
              required={!existing}
            />
          </div>
        </div>

        <div>
          <label className="field-label">Your current address</label>
          <input className="field-input" value={form.line1} onChange={set("line1")} required />
          <div className="mt-2 grid grid-cols-[1fr_5rem_7rem] gap-2">
            <input className="field-input" value={form.city} onChange={set("city")} placeholder="City" required />
            <input className="field-input" value={form.state} onChange={set("state")} placeholder="ST" maxLength={2} required />
            <input className="field-input" value={form.postalCode} onChange={set("postalCode")} placeholder="ZIP" required />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">Citizenship</label>
            <select className="field-input" value={form.citizenship} onChange={set("citizenship")}>
              <option value="us_citizen">US citizen</option>
              <option value="permanent_resident">Permanent resident</option>
              <option value="non_permanent_resident">Non-permanent resident</option>
            </select>
          </div>
          <div>
            <label className="field-label">Marital status</label>
            <select className="field-input" value={form.maritalStatus} onChange={set("maritalStatus")}>
              <option value="unmarried">Unmarried</option>
              <option value="married">Married</option>
              <option value="separated">Separated</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">You currently</label>
            <select className="field-input" value={form.currentHousing} onChange={set("currentHousing")}>
              <option value="rent">Rent</option>
              <option value="own">Own</option>
              <option value="rent_free">Live rent-free</option>
            </select>
          </div>
          {form.currentHousing === "rent" && (
            <div>
              <label className="field-label">Monthly rent</label>
              <input className="field-input figure" value={form.monthlyRent} onChange={set("monthlyRent")} inputMode="numeric" placeholder="2150" />
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-3 border-t border-line-light pt-5">
        <label className="flex gap-3 text-[13px] leading-relaxed text-ink-soft">
          <input type="checkbox" className="mt-0.5" checked={authorized}
                 onChange={(e) => setAuthorized(e.target.checked)} required />
          <span>
            I authorise a soft credit check and verification of my employment, income and assets.
            <span className="block text-subtle">
              Nothing is checked until you agree. A soft pull does not affect your score.
            </span>
          </span>
        </label>
        <label className="flex gap-3 text-[13px] leading-relaxed text-ink-soft">
          <input type="checkbox" className="mt-0.5" checked={econsent}
                 onChange={(e) => setEconsent(e.target.checked)} />
          <span>I agree to receive disclosures electronically.</span>
        </label>
      </div>

      <p className="mt-5 text-[12px] leading-relaxed text-subtle">
        We&rsquo;ll confirm your identity against a photo ID. In this prototype that step is
        simulated — no document is asked for and none is stored.
      </p>

      {error && <p className="mt-4 text-[13px] text-error">{error}</p>}

      <div className="mt-6 flex items-center gap-3">
        <button className="btn-primary" disabled={busy || !authorized || readOnly}>
          {phase === "verifying" ? "Confirming your identity…"
            : phase === "pulling" ? "Checking your credit…"
            : "Continue"}
        </button>
        <button type="button" className="btn-secondary" onClick={() => navigate(`/f/${fileId}/property`)}>
          Back
        </button>
      </div>
      {readOnly && <p className="mt-3 text-[13px] text-subtle">This is a sample file and can&rsquo;t be edited.</p>}
    </form>
  );
}
