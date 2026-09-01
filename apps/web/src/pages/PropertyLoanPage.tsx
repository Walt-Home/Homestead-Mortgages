import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";

/**
 * Screen 1. Drew's note is "under 60s of typing", so this asks for eight
 * things and computes the rest.
 *
 * `statedMonthlyIncome` is the field that is not in the sheet's screen-1 list,
 * and it earns its place: it is the sixth piece of the TRID application, and
 * without it here the three-business-day Loan Estimate clock cannot start
 * until a connector returns — which makes a regulatory deadline start at an
 * unpredictable moment. One unverified number fixes that.
 */
export function PropertyLoanPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Absent on /f/new/property, present when coming back to edit an existing file.
  const { fileId } = useParams<{ fileId: string }>();
  const { data } = useLoanFile(fileId);
  const editing = Boolean(fileId);
  const readOnly = data?.file.isDemo === true;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    purpose: "purchase",
    line1: "",
    city: "",
    state: "",
    postalCode: "",
    propertyType: "single_family",
    occupancy: "primary_residence",
    valueOrPrice: "",
    downPayment: "",
    statedMonthlyIncome: "",
    cashToBorrower: "",
    cashOutPurpose: "",
  });

  /**
   * Prefill when editing. Screen 1 was previously reachable only as
   * /f/new/property, so the sole way back to it was to abandon the file and
   * start over — orphaning every connection already made.
   */
  useEffect(() => {
    const f = data?.file;
    if (!f?.loan || !f.property) return;
    setForm((prev) => ({
      ...prev,
      purpose: f.loan!.purpose,
      line1: f.property!.address.line1,
      city: f.property!.address.city,
      state: f.property!.address.state,
      postalCode: f.property!.address.postalCode,
      propertyType: f.property!.propertyType,
      occupancy: f.property!.occupancy,
      valueOrPrice: String(f.property!.valueOrPrice),
      downPayment: String(f.loan!.downPayment),
      cashToBorrower: f.loan!.cashToBorrower ? String(f.loan!.cashToBorrower) : "",
      cashOutPurpose: f.loan!.cashOutPurpose ?? "",
    }));
  }, [data?.file]);

  const price = Number(form.valueOrPrice) || 0;
  const down = Number(form.downPayment) || 0;
  const loanAmount = Math.max(0, price - down);
  const downPercent = price > 0 ? Math.round((down / price) * 100) : 0;

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload = {
      purpose: form.purpose,
      address: {
        line1: form.line1,
        city: form.city,
        state: form.state.toUpperCase(),
        postalCode: form.postalCode,
      },
      propertyType: form.propertyType,
      occupancy: form.occupancy,
      valueOrPrice: price,
      loanAmount,
      downPayment: down,
      statedMonthlyIncome: Number(form.statedMonthlyIncome || 1),
      ...(form.purpose === "cash_out_refinance"
        ? {
            cashToBorrower: Number(form.cashToBorrower || 0),
            cashOutPurpose: form.cashOutPurpose || undefined,
          }
        : {}),
    };

    try {
      if (editing && fileId) {
        // PATCH, not POST: editing terms must not fork a second file.
        await api.patch(`/files/${fileId}`, payload);
        await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
        await queryClient.invalidateQueries({ queryKey: ["assessment"] });
        navigate(`/f/${fileId}/identity`);
      } else {
        const created = await api.post<{ id: string }>("/files", payload);
        navigate(`/f/${created.id}/identity`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSubmitting(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">Property and loan</h1>
      <p className="mt-2 text-[14px] text-muted">
        Eight fields. Everything else, we retrieve.
      </p>

      <div className="mt-6 grid gap-5">
        <div>
          <label className="field-label">What are you doing?</label>
          <select className="field-input" value={form.purpose} onChange={set("purpose")}>
            <option value="purchase">Buying a home</option>
            <option value="rate_term_refinance">Refinancing my rate or term</option>
            <option value="cash_out_refinance">Taking cash out</option>
          </select>
        </div>

        <div>
          <label className="field-label">Property address</label>
          <input
            className="field-input"
            value={form.line1}
            onChange={set("line1")}
            placeholder="1 Example Street"
            required
          />
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

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">Property type</label>
            <select className="field-input" value={form.propertyType} onChange={set("propertyType")}>
              <option value="single_family">Single family</option>
              <option value="condo">Condo</option>
              <option value="townhouse">Townhouse</option>
              <option value="two_to_four_unit">2–4 units</option>
              <option value="manufactured">Manufactured</option>
            </select>
          </div>
          <div>
            <label className="field-label">How will you use it?</label>
            <select className="field-input" value={form.occupancy} onChange={set("occupancy")}>
              <option value="primary_residence">Primary home</option>
              <option value="second_home">Second home</option>
              <option value="investment">Investment</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">
              {form.purpose === "purchase" ? "Purchase price" : "Estimated value"}
            </label>
            <input
              className="field-input figure"
              value={form.valueOrPrice}
              onChange={set("valueOrPrice")}
              inputMode="numeric"
              placeholder="650000"
              required
            />
          </div>
          <div>
            <label className="field-label">Down payment</label>
            <input
              className="field-input figure"
              value={form.downPayment}
              onChange={set("downPayment")}
              inputMode="numeric"
              placeholder="130000"
              required
            />
          </div>
        </div>

        <div>
          <label className="field-label">Your monthly income, roughly</label>
          <input
            className="field-input figure"
            value={form.statedMonthlyIncome}
            onChange={set("statedMonthlyIncome")}
            inputMode="numeric"
            placeholder="7800"
            required
          />
          <p className="mt-1.5 text-[12px] text-subtle">
            An estimate is fine — we verify this from your accounts later. It lets us start your
            Loan Estimate clock on time.
          </p>
        </div>
      </div>

      {loanAmount > 0 && (
        <div className="mt-6 rounded-row bg-raised px-4 py-3">
          <span className="text-[13px] text-muted">Loan amount</span>
          <span className="figure ml-3 text-[18px] text-ink-editorial">
            ${loanAmount.toLocaleString()}
          </span>
          <span className="ml-2 text-[13px] text-meta">{downPercent}% down</span>
        </div>
      )}

      {error && <p className="mt-4 text-[13px] text-error">{error}</p>}

      {form.purpose === "cash_out_refinance" && (
        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <label className="field-label">Cash to you at closing</label>
            <input
              className="field-input figure"
              value={form.cashToBorrower}
              onChange={set("cashToBorrower")}
              inputMode="numeric"
              placeholder="40000"
            />
          </div>
          <div>
            <label className="field-label">What is it for?</label>
            <input
              className="field-input"
              value={form.cashOutPurpose}
              onChange={set("cashOutPurpose")}
              placeholder="Home improvements"
            />
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button className="btn-primary" disabled={submitting || readOnly}>
          {submitting ? "Saving…" : editing ? "Save and continue" : "Continue"}
        </button>
        {editing && (
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>
            Back
          </button>
        )}
      </div>
      {readOnly && (
        <p className="mt-3 text-[13px] text-subtle">
          This is a sample file and can&rsquo;t be edited.
        </p>
      )}
    </form>
  );
}
