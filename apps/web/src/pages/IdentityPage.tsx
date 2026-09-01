import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

/**
 * Screen 2. Required before any pull, because APP-005's timing constraint is
 * "Before any verification pull" and the guard in the connector layer enforces
 * it — a pull attempted without the signature returns 403, not data.
 *
 * The SSN never reaches our API as a number. In a real build this field posts
 * to an identity vault and we keep the handle it returns; the prototype
 * simulates that exchange client-side so no code above ever learns to expect
 * a plaintext SSN in a request body.
 */
export function IdentityPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [econsent, setEconsent] = useState(false);

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    dateOfBirth: "",
    ssn: "",
    line1: "",
    city: "",
    state: "",
    postalCode: "",
    maritalStatus: "unmarried",
    currentHousing: "rent",
    monthlyRent: "",
    statedMonthlyIncome: "",
    firstTimeHomebuyer: "false",
  });

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fileId) return;
    setSubmitting(true);
    setError(null);
    try {
      const digits = form.ssn.replace(/\D/g, "");
      const created = await api.post<{ id: string }>(`/files/${fileId}/borrowers`, {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        dateOfBirth: form.dateOfBirth,
        // Stand-in for the vault exchange. The real number is not sent.
        ssnVaultHandle: `vault:${digits.slice(-4)}:${crypto.randomUUID()}`,
        ssnLast4: digits.slice(-4),
        currentAddress: {
          line1: form.line1,
          city: form.city,
          state: form.state.toUpperCase(),
          postalCode: form.postalCode,
        },
        maritalStatus: form.maritalStatus,
        preferredLanguage: "en",
        firstTimeHomebuyer: form.firstTimeHomebuyer === "true",
        currentHousing: form.currentHousing,
        monthlyRent: form.monthlyRent ? Number(form.monthlyRent) : undefined,
        demographics: { ethnicity: "declined", race: "declined", sex: "declined", visualObservationNoted: false },
        statedMonthlyIncome: Number(form.statedMonthlyIncome || 1),
      });

      // Record the two consents the flow depends on. Everything downstream is
      // refused without the first.
      const file = await api.get<{ file: { borrowers: { id: string }[] } }>(`/files/${fileId}`);
      const borrowerId = file.file.borrowers[0]?.id;
      if (borrowerId) {
        await api.post(`/files/${fileId}/consents`, {
          kind: "verification_authorization",
          borrowerId,
        });
        if (econsent) {
          await api.post(`/files/${fileId}/consents`, { kind: "econsent", borrowerId });
        }
      }
      navigate(`/f/${created.id}/credit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your details.");
      setSubmitting(false);
    }
  }

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
            <input
              className="field-input"
              type="date"
              value={form.dateOfBirth}
              onChange={set("dateOfBirth")}
              required
            />
          </div>
          <div>
            <label className="field-label">Social Security number</label>
            <input
              className="field-input figure"
              value={form.ssn}
              onChange={set("ssn")}
              placeholder="000-00-0000"
              required
            />
          </div>
        </div>

        <div>
          <label className="field-label">Your current address</label>
          <input className="field-input" value={form.line1} onChange={set("line1")} required />
          <div className="mt-2 grid grid-cols-[1fr_5rem_7rem] gap-2">
            <input className="field-input" value={form.city} onChange={set("city")} placeholder="City" required />
            <input
              className="field-input"
              value={form.state}
              onChange={set("state")}
              placeholder="ST"
              maxLength={2}
              required
            />
            <input
              className="field-input"
              value={form.postalCode}
              onChange={set("postalCode")}
              placeholder="ZIP"
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="field-label">Marital status</label>
            <select className="field-input" value={form.maritalStatus} onChange={set("maritalStatus")}>
              <option value="unmarried">Unmarried</option>
              <option value="married">Married</option>
              <option value="separated">Separated</option>
            </select>
          </div>
          <div>
            <label className="field-label">You currently</label>
            <select className="field-input" value={form.currentHousing} onChange={set("currentHousing")}>
              <option value="rent">Rent</option>
              <option value="own">Own</option>
              <option value="rent_free">Live rent-free</option>
            </select>
          </div>
          <div>
            <label className="field-label">First home?</label>
            <select
              className="field-input"
              value={form.firstTimeHomebuyer}
              onChange={set("firstTimeHomebuyer")}
            >
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </div>
        </div>

        {form.currentHousing === "rent" && (
          <div>
            <label className="field-label">Monthly rent</label>
            <input
              className="field-input figure"
              value={form.monthlyRent}
              onChange={set("monthlyRent")}
              inputMode="numeric"
              placeholder="2150"
            />
            <p className="mt-1.5 text-[12px] text-subtle">
              Twelve months of on-time rent can count as credit if your file is thin.
            </p>
          </div>
        )}
      </div>

      <div className="mt-6 space-y-3 border-t border-line-light pt-5">
        <label className="flex gap-3 text-[13px] leading-relaxed text-ink-soft">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
            required
          />
          <span>
            I authorize a soft credit check and verification of my employment, income and assets.
            <span className="block text-subtle">
              Nothing is checked until you agree. A soft pull does not affect your score.
            </span>
          </span>
        </label>
        <label className="flex gap-3 text-[13px] leading-relaxed text-ink-soft">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={econsent}
            onChange={(e) => setEconsent(e.target.checked)}
          />
          <span>I agree to receive disclosures electronically.</span>
        </label>
      </div>

      {error && <p className="mt-4 text-[13px] text-error">{error}</p>}

      <button className="btn-primary mt-6" disabled={submitting || !authorized}>
        {submitting ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
