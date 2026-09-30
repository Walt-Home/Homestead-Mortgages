/**
 * Who a servicer is when it is invoiced: the legal entity, where the
 * invoice goes, and the terms. Saved here and nowhere else; the payment
 * provider hears about a change at the next draft, so a corrected typo
 * never mails anything by itself. What an invoice cannot be drafted without
 * is named back as gaps, in words.
 */

import { useState } from "react";
import { Button, Field, Input, Notice } from "./ui.js";
import { useAct } from "../lib/act.js";
import { fmtDateTime } from "../lib/format.js";
import { GAP_WORDS, type BillingProfile, type ProfileGap } from "../lib/billing.js";

const NET_DAYS = [0, 15, 30, 45, 60, 90];

export function BillingProfileForm({
  slug,
  profile,
  gaps,
}: {
  slug: string;
  profile: BillingProfile;
  gaps: readonly ProfileGap[];
}) {
  const act = useAct({ invalidate: [["billing-servicer", slug]], done: "Saved" });
  const [form, setForm] = useState({
    legalName: profile.legalName ?? "",
    billingEmail: profile.billingEmail ?? "",
    addressLine1: profile.addressLine1 ?? "",
    addressLine2: profile.addressLine2 ?? "",
    city: profile.city ?? "",
    state: profile.state ?? "",
    postalCode: profile.postalCode ?? "",
    ein: profile.ein ?? "",
    netDays: profile.netDays === null ? "" : String(profile.netDays),
    purchaseOrder: profile.purchaseOrder ?? "",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = () =>
    act.run(`/servicers/${slug}/profile`, {
      method: "PUT",
      door: "billing",
      body: {
        ...form,
        country: "US",
        netDays: form.netDays === "" ? null : Number(form.netDays),
      },
    });

  return (
    <div className="space-y-4 rounded-lg border border-line-2 bg-surface p-4">
      {gaps.length > 0 ? (
        <Notice tone="warn" title="Not enough to invoice yet">
          Still missing {gaps.map((g) => GAP_WORDS[g]).join(", ")}.
        </Notice>
      ) : (
        <Notice tone="ok">
          Enough to invoice.
          {profile.customer
            ? ` Known to ${profile.customer.provider} as ${profile.customer.id}.`
            : " The provider will be told at the first draft."}
        </Notice>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Legal name" htmlFor="bp-legal" hint="As it should read on the invoice.">
          <Input id="bp-legal" value={form.legalName} onChange={set("legalName")} />
        </Field>
        <Field label="Invoice goes to" htmlFor="bp-email" hint="The address the provider mails.">
          <Input
            id="bp-email"
            type="email"
            value={form.billingEmail}
            onChange={set("billingEmail")}
          />
        </Field>
        <Field label="Address" htmlFor="bp-line1" className="sm:col-span-2">
          <Input
            id="bp-line1"
            value={form.addressLine1}
            onChange={set("addressLine1")}
            placeholder="Street"
          />
        </Field>
        <Field label="Address, line 2" htmlFor="bp-line2" className="sm:col-span-2">
          <Input id="bp-line2" value={form.addressLine2} onChange={set("addressLine2")} />
        </Field>
        <Field label="City" htmlFor="bp-city">
          <Input id="bp-city" value={form.city} onChange={set("city")} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="State" htmlFor="bp-state">
            <Input
              id="bp-state"
              value={form.state}
              onChange={set("state")}
              maxLength={2}
              placeholder="TX"
            />
          </Field>
          <Field label="ZIP" htmlFor="bp-zip">
            <Input
              id="bp-zip"
              value={form.postalCode}
              onChange={set("postalCode")}
              inputMode="numeric"
            />
          </Field>
        </div>
        <Field label="EIN" htmlFor="bp-ein" hint="Printed on the invoice. Written 12-3456789.">
          <Input id="bp-ein" value={form.ein} onChange={set("ein")} placeholder="12-3456789" />
        </Field>
        <Field
          label="Payment terms"
          htmlFor="bp-net"
          hint="Days from issue until due, from the contract."
        >
          <select
            id="bp-net"
            value={form.netDays}
            onChange={(e) => setForm((f) => ({ ...f, netDays: e.target.value }))}
            className="h-10 w-full rounded-md border border-line-2 bg-surface px-3 text-base text-fg"
          >
            <option value="">Not agreed yet</option>
            {NET_DAYS.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? "Due on receipt" : `Net ${d}`}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="PO number"
          htmlFor="bp-po"
          hint="If they need one on the invoice."
          className="sm:col-span-2"
        >
          <Input id="bp-po" value={form.purchaseOrder} onChange={set("purchaseOrder")} />
        </Field>
      </div>
      {act.error ? <Notice tone="danger">{act.error.message}</Notice> : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-fg-3">
          {profile.updatedAt ? `Saved ${fmtDateTime(profile.updatedAt)}` : "Never saved"}
        </span>
        <Button variant="primary" loading={act.busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
