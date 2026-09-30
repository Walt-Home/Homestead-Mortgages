/**
 * Credit notes on an invoice: the correction to what has been sent or paid.
 * Issuing one is a sheet with the amount, why, what the customer reads,
 * and — on a paid invoice — how it is settled; the list beneath the invoice
 * shows each note, its PDF, and Void while the invoice is still open.
 */

import { useState } from "react";
import { Sheet } from "./Sheet.js";
import { Button, Field, Input, Notice, Pill, Textarea, type Tone } from "./ui.js";
import { useToast } from "./Toast.js";
import { useAct } from "../lib/act.js";
import { fmtDateTime, money } from "../lib/format.js";
import {
  billing,
  CREDIT_REASON_WORDS,
  SETTLEMENT_WORDS,
  type CreditNoteReason,
  type CreditNoteSettlement,
  type CreditNoteView,
  type InvoiceView,
} from "../lib/billing.js";

const NOTE_TONE: Record<CreditNoteView["standing"], Tone> = {
  pending: "warn",
  issued: "ok",
  void: "neutral",
};

/** Dollars typed by a person, as cents; null when it is not an amount. */
function centsOf(text: string): bigint | null {
  const m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ""));
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "0").padEnd(2, "0"));
}

export function CreditNoteSheet({
  slug,
  invoice,
  ceilingCents,
  onClose,
}: {
  slug: string;
  invoice: InvoiceView;
  /** The most that can be credited now: what is still due, or what was paid less what is credited. */
  ceilingCents: bigint;
  onClose: () => void;
}) {
  const act = useAct({
    invalidate: [["billing-servicer", slug], ["billing-credit-notes"]],
    done: "Credit note issued",
  });
  const paid = invoice.standing === "paid";
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<CreditNoteReason>("order_change");
  const [memo, setMemo] = useState("");
  const [settlement, setSettlement] = useState<CreditNoteSettlement>("customer_balance");
  const cents = centsOf(amount);
  const valid = cents !== null && cents > 0n && cents <= ceilingCents && memo.trim().length >= 3;
  const issue = () =>
    act
      .run(`/invoices/${invoice.id}/credit-notes`, {
        method: "POST",
        door: "billing",
        body: {
          amountCents: cents!.toString(),
          reason,
          memo: memo.trim(),
          settlement: paid ? settlement : null,
        },
      })
      .then((ok) => ok && onClose());

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Credit invoice ${invoice.number ?? ""}`.trim()}
      subtitle={
        paid
          ? "The invoice was paid, so the credit has to go somewhere."
          : "The invoice is open, so the credit lowers what is due."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={act.busy}
            disabled={!valid}
            onClick={() => void issue()}
          >
            Issue {cents !== null && cents > 0n ? money(cents.toString()) : "credit"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Amount"
          htmlFor="cn-amount"
          hint={`Up to ${money(ceilingCents.toString())}${paid ? ", what was paid less what is already credited" : ", what is still due"}.`}
          error={
            amount && cents === null
              ? "Dollars and cents, like 125.00."
              : cents !== null && cents > ceilingCents
                ? "More than can be credited."
                : undefined
          }
        >
          <Input
            id="cn-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Field
          label="Why"
          htmlFor="cn-reason"
          hint="Stripe's own vocabulary; it is recorded on the note."
        >
          <select
            id="cn-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as CreditNoteReason)}
            className="h-10 w-full rounded-md border border-line-2 bg-surface px-3 text-base text-fg"
          >
            {(Object.keys(CREDIT_REASON_WORDS) as CreditNoteReason[]).map((r) => (
              <option key={r} value={r}>
                {CREDIT_REASON_WORDS[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What the customer reads" htmlFor="cn-memo" hint="Printed on the credit note.">
          <Textarea
            id="cn-memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="min-h-24"
          />
        </Field>
        {paid ? (
          <Field label="Settled by">
            <div className="space-y-2">
              {(
                [
                  [
                    "customer_balance",
                    "A credit on the customer's balance, off their next invoice",
                  ],
                  ["refund", "A refund of the payment through Stripe"],
                  ["out_of_band", "A refund made outside Stripe, by wire"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-start gap-2 text-sm text-fg">
                  <input
                    type="radio"
                    name="cn-settlement"
                    className="mt-1"
                    checked={settlement === value}
                    onChange={() => setSettlement(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </Field>
        ) : null}
        {act.error ? <Notice tone="danger">{act.error.message}</Notice> : null}
        <Notice tone="neutral">
          A credit note is recorded on the invoice's history with your name, and Stripe sends the
          customer the note.{" "}
          {paid
            ? "Once the invoice is paid, a credit cannot be voided."
            : "It can be voided while the invoice is still open."}
        </Notice>
      </div>
    </Sheet>
  );
}

export function CreditNoteList({
  slug,
  invoice,
  notes,
}: {
  slug: string;
  invoice: InvoiceView;
  notes: readonly CreditNoteView[];
}) {
  const toast = useToast();
  const cancel = useAct({
    invalidate: [["billing-servicer", slug], ["billing-credit-notes"]],
    done: "Credit note voided",
  });
  const [voiding, setVoiding] = useState<CreditNoteView | null>(null);
  const [reason, setReason] = useState("");
  const openPdf = async (note: CreditNoteView) => {
    const tab = window.open("", "_blank", "noopener");
    try {
      const { pdfUrl } = await billing<{ pdfUrl: string }>(`/credit-notes/${note.id}/link`);
      if (tab) tab.location.href = pdfUrl;
      else window.location.assign(pdfUrl);
    } catch (err) {
      tab?.close();
      toast({ tone: "danger", title: "The PDF could not be opened", body: (err as Error).message });
    }
  };
  if (notes.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-fg">Credit notes</h3>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line-2">
        {notes.map((n) => (
          <li
            key={n.id}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <Pill tone={NOTE_TONE[n.standing]}>{n.standing}</Pill>
                {n.number ? <span className="font-mono text-xs text-fg-2">{n.number}</span> : null}
                <span className="font-medium text-fg">{money(n.amountCents)}</span>
                <span className="text-fg-3">{SETTLEMENT_WORDS[n.settlement]}</span>
              </span>
              <span className="text-xs text-fg-3">
                {CREDIT_REASON_WORDS[n.reason]} · {n.memo} · {fmtDateTime(n.createdAt)}
                {n.voidedAt ? ` · voided ${fmtDateTime(n.voidedAt)}` : ""}
                {!n.atProvider
                  ? " · the provider never answered; the reconciliation retries it"
                  : ""}
              </span>
            </span>
            <span className="flex gap-2">
              {n.atProvider ? (
                <Button size="sm" variant="secondary" onClick={() => void openPdf(n)}>
                  PDF
                </Button>
              ) : null}
              {n.standing === "issued" && invoice.standing !== "paid" ? (
                <Button size="sm" variant="ghost" onClick={() => setVoiding(n)}>
                  Void…
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {voiding ? (
        <Sheet
          open
          onClose={() => setVoiding(null)}
          title={`Void credit note ${voiding.number ?? ""}`.trim()}
          subtitle="The invoice's amount due comes back. Allowed only while the invoice is open."
          footer={
            <>
              <Button variant="ghost" onClick={() => setVoiding(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                loading={cancel.busy}
                disabled={reason.trim().length < 3}
                onClick={() =>
                  void cancel
                    .run(`/credit-notes/${voiding.id}/void`, {
                      method: "POST",
                      door: "billing",
                      body: { reason: reason.trim() },
                    })
                    .then((ok) => ok && setVoiding(null))
                }
              >
                Void
              </Button>
            </>
          }
        >
          <Field
            label="Why"
            htmlFor="cn-void-why"
            hint="Recorded on the invoice's history with your name."
          >
            <Textarea
              id="cn-void-why"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-24"
            />
          </Field>
          {cancel.error ? (
            <Notice tone="danger" className="mt-3">
              {cancel.error.message}
            </Notice>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}
