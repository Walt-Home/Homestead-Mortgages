/**
 * The invoice for a closed month: where it stands and what a person may
 * do next. Each act is its own press with its own word — draft, review and
 * send, void with a reason, mark paid with a note — because sending money's
 * worth of invoice is never a side effect of something else, and who
 * pressed is recorded.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet } from "./Sheet.js";
import { CreditNoteList, CreditNoteSheet } from "./CreditNotes.js";
import { Button, Notice, Pill, Rows, Textarea, type Tone } from "./ui.js";
import { useAct } from "../lib/act.js";
import { useToast } from "./Toast.js";
import { fmtDate, fmtDateTime, money, plural } from "../lib/format.js";
import {
  billing,
  GAP_WORDS,
  monthLabel,
  openInvoicePage,
  paymentMethodWord,
  tokensWord,
  type BillingProfile,
  type CreditNoteView,
  type InvoiceLink,
  type InvoiceStandingWord,
  type InvoiceView,
  type InvoicingStanding,
  type ProfileGap,
  type Statement,
} from "../lib/billing.js";

export const INVOICE_WORDS: Record<InvoiceStandingWord, { word: string; tone: Tone }> = {
  draft: { word: "Draft", tone: "neutral" },
  open: { word: "Finalized, not sent", tone: "warn" },
  sent: { word: "Sent", tone: "info" },
  past_due: { word: "Past due", tone: "danger" },
  paid: { word: "Paid", tone: "ok" },
  void: { word: "Voided", tone: "neutral" },
  uncollectible: { word: "Written off", tone: "danger" },
};

function ReasonSheet({
  title,
  subtitle,
  label,
  button,
  danger,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  subtitle: string;
  label: string;
  button: string;
  danger?: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={busy}
            disabled={text.trim().length < 3}
            onClick={() => onConfirm(text.trim())}
          >
            {button}
          </Button>
        </>
      }
    >
      <label className="block text-sm font-medium text-fg" htmlFor="inv-reason">
        {label}
      </label>
      <Textarea
        id="inv-reason"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="mt-1.5 min-h-24"
      />
      <p className="mt-1.5 text-sm text-fg-3">Recorded on the invoice's history with your name.</p>
    </Sheet>
  );
}

function ReviewSheet({
  invoice,
  statement,
  profile,
  invoicing,
  busy,
  onClose,
  onSend,
}: {
  invoice: InvoiceView;
  statement: Statement;
  profile: BillingProfile;
  invoicing: InvoicingStanding;
  busy: boolean;
  onClose: () => void;
  onSend: () => void;
}) {
  const lines = statement.lines.filter((l) => BigInt(l.cents) > 0n);
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Send the invoice for ${monthLabel(invoice.month)}`}
      subtitle="Read it as they will. Once sent, the amount cannot change."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not yet
          </Button>
          <Button variant="primary" loading={busy} onClick={onSend}>
            Send {money(invoice.amountCents)}
          </Button>
        </>
      }
    >
      <Rows
        rows={[
          { label: "To", value: `${profile.legalName ?? "—"} · ${profile.billingEmail ?? "—"}` },
          {
            label: "Amount",
            value: `${money(invoice.amountCents)} · ${tokensWord(statement.tokens)}`,
          },
          {
            label: "Terms",
            value: invoice.netDays === 0 ? "Due on receipt" : `Net ${invoice.netDays}`,
          },
          {
            label: "Payable by",
            value: invoicing.paymentMethods.map(paymentMethodWord).join(", "),
          },
          ...(profile.purchaseOrder ? [{ label: "PO number", value: profile.purchaseOrder }] : []),
          {
            label: "Issued by",
            value: `${invoicing.provider}${invoice.livemode ? "" : " · no real money moves"}`,
          },
        ]}
      />
      <h3 className="mt-5 text-sm font-semibold text-fg">Lines</h3>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line-2">
        {lines.map((l) => (
          <li key={l.code} className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
            <span className="text-fg-2">
              {l.action.split(":")[0]}
              <span className="block text-xs text-fg-3">
                {l.quantity.kind === "loan_months"
                  ? `${l.quantity.loanMonths} loan-months on ${money(l.quantity.balanceCents)} across ${plural(l.quantity.loans, "loan")}`
                  : plural(l.quantity.count, "touch", "touches")}
              </span>
            </span>
            <span className="tabular-nums font-medium text-fg">{money(l.cents)}</span>
          </li>
        ))}
      </ul>
      {!invoice.livemode ? (
        <Notice tone="info" className="mt-4">
          This is a sandbox invoice: it is issued, it has a page, and it moves no money.
        </Notice>
      ) : null}
    </Sheet>
  );
}

export function InvoicePanel({
  slug,
  month,
  statement,
  invoice,
  profile,
  gaps,
  invoicing,
}: {
  slug: string;
  month: string;
  statement: Statement;
  /** The month's live invoice, or the last voided one, or none. */
  invoice: InvoiceView | null;
  profile: BillingProfile;
  gaps: readonly ProfileGap[];
  invoicing: InvoicingStanding;
}) {
  const invalidate = [["billing-servicer", slug]] as const;
  const draft = useAct({ invalidate, done: "Drafted" });
  const send = useAct({ invalidate, done: "Sent" });
  const cancel = useAct({ invalidate, done: "Done" });
  const paid = useAct({ invalidate, done: "Recorded" });
  const sync = useAct({ invalidate, done: "Read again" });
  const toast = useToast();
  const [sheet, setSheet] = useState<"review" | "void" | "paid" | "credit" | null>(null);

  const live = invoice && invoice.standing !== "void" ? invoice : null;
  const creditable =
    live?.atProvider === true &&
    ["open", "sent", "past_due", "paid", "uncollectible"].includes(live.standing);
  const notes = useQuery({
    queryKey: ["billing-credit-notes", live?.id ?? "none"],
    queryFn: () =>
      billing<{ creditNotes: CreditNoteView[] }>(`/invoices/${live!.id}/credit-notes`).then(
        (r) => r.creditNotes,
      ),
    enabled: creditable,
  });
  const noteList = notes.data ?? [];
  // What can still be credited: what is due on an open invoice, or what was
  // paid less what is already credited on a paid one; a pending note counts.
  const creditedCents = noteList
    .filter((n) => n.standing !== "void")
    .reduce((sum, n) => sum + BigInt(n.amountCents), 0n);
  const ceilingCents = live
    ? live.standing === "paid"
      ? BigInt(live.amountPaidCents) - creditedCents
      : BigInt(live.amountRemainingCents) -
        noteList
          .filter((n) => n.standing === "pending")
          .reduce((sum, n) => sum + BigInt(n.amountCents), 0n)
    : 0n;
  const nothing = BigInt(statement.cents) <= 0n;
  const tooMuch = BigInt(statement.cents) > BigInt(invoicing.maxInvoiceCents);
  const cannotDraft = !invoicing.canIssue
    ? invoicing.cannotIssueBecause
    : nothing
      ? "The month consumed nothing."
      : tooMuch
        ? `Above the ${money(invoicing.maxInvoiceCents)} a single bank payment can carry.`
        : gaps.length > 0
          ? `The billing profile still needs ${gaps.map((g) => GAP_WORDS[g]).join(", ")}.`
          : null;

  const open = () =>
    openInvoicePage(() => billing<InvoiceLink>(`/invoices/${live!.id}/link`)).catch((err: Error) =>
      toast({ tone: "danger", title: "The page could not be opened", body: err.message }),
    );

  const standing = live ? INVOICE_WORDS[live.standing] : null;

  return (
    <div className="rounded-lg border border-line-2 bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {standing && live ? (
            <>
              <Pill tone={standing.tone}>{standing.word}</Pill>
              {live.number ? (
                <span className="font-mono text-sm text-fg-2">{live.number}</span>
              ) : null}
              {!live.atProvider ? (
                <span className="text-sm text-warn">
                  The provider never answered; draft again to resume.
                </span>
              ) : null}
              {!live.livemode && invoicing.mode !== "fixture" ? (
                <span className="text-xs text-fg-3">sandbox</span>
              ) : null}
            </>
          ) : (
            <span className="text-sm text-fg-2">
              {invoice?.standing === "void"
                ? `The last invoice was voided ${fmtDate(invoice.voidedAt)}; the month can be issued again.`
                : "Not yet invoiced."}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!live || !live.atProvider ? (
            <Button
              variant="primary"
              loading={draft.busy}
              disabled={cannotDraft !== null}
              title={cannotDraft ?? undefined}
              onClick={() =>
                void draft.run(`/servicers/${slug}/statements/${month}/invoice`, {
                  method: "POST",
                  body: {},
                  door: "billing",
                })
              }
            >
              {live ? "Draft again" : "Draft invoice"}
            </Button>
          ) : null}
          {live?.atProvider && live.standing === "draft" ? (
            <>
              <Button variant="primary" onClick={() => setSheet("review")}>
                Review and send…
              </Button>
              <Button variant="secondary" onClick={() => setSheet("void")}>
                Discard…
              </Button>
            </>
          ) : null}
          {live && ["open", "sent", "past_due", "paid", "uncollectible"].includes(live.standing) ? (
            <Button variant="secondary" onClick={() => void open()}>
              Open invoice page
            </Button>
          ) : null}
          {live && ["open", "sent", "past_due", "uncollectible"].includes(live.standing) ? (
            <>
              <Button variant="secondary" onClick={() => setSheet("paid")}>
                Mark paid outside Stripe…
              </Button>
              <Button variant="danger" onClick={() => setSheet("void")}>
                Void…
              </Button>
            </>
          ) : null}
          {creditable && ceilingCents > 0n ? (
            <Button variant="secondary" onClick={() => setSheet("credit")}>
              Credit…
            </Button>
          ) : null}
          {live?.atProvider && live.standing !== "draft" ? (
            <Button
              variant="ghost"
              loading={sync.busy}
              onClick={() =>
                void sync.run(`/invoices/${live.id}/sync`, {
                  method: "POST",
                  body: {},
                  door: "billing",
                })
              }
            >
              Read again
            </Button>
          ) : null}
        </div>
      </div>

      {live ? (
        <div className="mt-4">
          <Rows
            rows={[
              { label: "Amount", value: money(live.amountCents) },
              ...(creditedCents > 0n
                ? [{ label: "Credited", value: money(creditedCents.toString()) }]
                : []),
              ...(live.standing !== "draft"
                ? [
                    {
                      label: "Remaining",
                      value: money(live.amountRemainingCents),
                    },
                    { label: "Due", value: live.dueAt ? fmtDate(live.dueAt) : "—" },
                  ]
                : [
                    {
                      label: "Terms",
                      value: live.netDays === 0 ? "Due on receipt" : `Net ${live.netDays}`,
                    },
                  ]),
              { label: "Drafted", value: `${fmtDateTime(live.createdAt)} by staff` },
              ...(live.sentAt
                ? [{ label: "Sent", value: `${fmtDateTime(live.sentAt)} by staff` }]
                : []),
              ...(live.paidAt
                ? [
                    {
                      label: "Paid",
                      value: `${fmtDateTime(live.paidAt)}${live.paidOutOfBand ? " · outside Stripe" : ""}`,
                    },
                  ]
                : []),
              ...(live.uncollectibleAt
                ? [{ label: "Written off", value: fmtDateTime(live.uncollectibleAt) }]
                : []),
              ...(live.lastSyncedAt
                ? [{ label: "Last read", value: fmtDateTime(live.lastSyncedAt) }]
                : []),
            ]}
          />
          {live.atProvider ? <CreditNoteList slug={slug} invoice={live} notes={noteList} /> : null}
        </div>
      ) : cannotDraft && !nothing ? (
        <Notice tone="neutral" className="mt-4">
          {cannotDraft}
        </Notice>
      ) : null}
      {(draft.error ?? send.error ?? cancel.error ?? paid.error ?? sync.error) ? (
        <Notice tone="danger" className="mt-4">
          {(draft.error ?? send.error ?? cancel.error ?? paid.error ?? sync.error)!.message}
        </Notice>
      ) : null}

      {sheet === "review" && live ? (
        <ReviewSheet
          invoice={live}
          statement={statement}
          profile={profile}
          invoicing={invoicing}
          busy={send.busy}
          onClose={() => setSheet(null)}
          onSend={() =>
            void send
              .run(`/invoices/${live.id}/send`, { method: "POST", body: {}, door: "billing" })
              .then((ok) => ok && setSheet(null))
          }
        />
      ) : null}
      {sheet === "void" && live ? (
        <ReasonSheet
          title={live.standing === "draft" ? "Discard this draft" : "Void this invoice"}
          subtitle={
            live.standing === "draft"
              ? "Nothing was sent. The month can be drafted again."
              : "It stays on record as voided, and the month can be issued again."
          }
          label="Why"
          button={live.standing === "draft" ? "Discard" : "Void"}
          danger={live.standing !== "draft"}
          busy={cancel.busy}
          onClose={() => setSheet(null)}
          onConfirm={(reason) =>
            void cancel
              .run(`/invoices/${live.id}/void`, {
                method: "POST",
                body: { reason },
                door: "billing",
              })
              .then((ok) => ok && setSheet(null))
          }
        />
      ) : null}
      {sheet === "credit" && live ? (
        <CreditNoteSheet
          slug={slug}
          invoice={live}
          ceilingCents={ceilingCents}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "paid" && live ? (
        <ReasonSheet
          title="Record a payment made outside Stripe"
          subtitle="A wire that reached the bank directly. No charge is made; the invoice is marked paid."
          label="How it was paid"
          button="Mark paid"
          busy={paid.busy}
          onClose={() => setSheet(null)}
          onConfirm={(note) =>
            void paid
              .run(`/invoices/${live.id}/paid`, { method: "POST", body: { note }, door: "billing" })
              .then((ok) => ok && setSheet(null))
          }
        />
      ) : null}
    </div>
  );
}
