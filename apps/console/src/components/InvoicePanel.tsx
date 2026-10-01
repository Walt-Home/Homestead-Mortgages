/**
 * The invoice for a closed month: where it stands and what a person may
 * do next. Each act is its own press with its own word — draft, review and
 * approve, review and send, void with a reason, mark paid with a note —
 * because sending money's worth of invoice is never a side effect of
 * something else, and who pressed is recorded by name.
 *
 * Two people stand between a draft and a sent invoice: one admin approves
 * it after reading it as the servicer will, and a different admin sends
 * it. The panel knows who is looking and says so when the person who
 * approved is the one about to press Send.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet } from "./Sheet.js";
import { CreditNoteList, CreditNoteSheet } from "./CreditNotes.js";
import { Button, Notice, Pill, Rows, Textarea, type Tone } from "./ui.js";
import { useAct } from "../lib/act.js";
import { useAuth } from "../lib/auth.js";
import { useToast } from "./Toast.js";
import { fmtDate, fmtDateTime, money, plural } from "../lib/format.js";
import {
  billing,
  GAP_WORDS,
  monthLabel,
  openInvoicePage,
  paymentMethodWord,
  stripeDashboardUrl,
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
  approved: { word: "Approved, not sent", tone: "info" },
  open: { word: "Finalized, not sent", tone: "warn" },
  sent: { word: "Sent", tone: "info" },
  past_due: { word: "Past due", tone: "danger" },
  paid: { word: "Paid", tone: "ok" },
  void: { word: "Voided", tone: "neutral" },
  uncollectible: { word: "Written off", tone: "danger" },
};

/** A person's name as the record has it, or the word for a staff act whose name was not kept. */
const by = (name: string | null | undefined): string => (name ? `by ${name}` : "by staff");

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

/**
 * What the provider prints at the head of the invoice beside what our
 * footer says, and whether the two agree. A sandbox that disagrees is only
 * confusing; a live account that disagrees refuses the send.
 */
function IssuerNotice({
  invoicing,
  livemode,
}: {
  invoicing: InvoicingStanding;
  livemode: boolean;
}) {
  if (invoicing.printed === null) {
    return (
      <Notice tone={livemode ? "danger" : "neutral"} className="mt-4" title="Who Stripe prints">
        {invoicing.printedError ?? "The account behind the billing key could not be read."}
        {livemode ? " A real invoice is not sent until it can be." : ""}
      </Notice>
    );
  }
  if (invoicing.issuerAgrees) return null;
  return (
    <Notice
      tone={livemode ? "danger" : "warn"}
      className="mt-4"
      title={`Stripe prints "${invoicing.printed.name ?? ""}" at the head of this invoice`}
    >
      The footer names {invoicing.issuer.name}.{" "}
      {livemode
        ? "A real invoice is refused until the Stripe account's public business name is ours."
        : "On the sandbox that is only confusing; on the live account the send would be refused."}
    </Notice>
  );
}

function ReviewSheet({
  mode,
  invoice,
  statement,
  profile,
  invoicing,
  busy,
  onClose,
  onConfirm,
}: {
  /** Approve: the first reading. Send: the second person's. */
  mode: "approve" | "send";
  invoice: InvoiceView;
  statement: Statement;
  profile: BillingProfile;
  invoicing: InvoicingStanding;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const lines = statement.lines.filter((l) => BigInt(l.cents) > 0n);
  const terms = invoice.termsUrl ?? invoicing.issuer.termsUrl;
  const cannotSend =
    mode === "send" && invoice.livemode && invoicing.issuerAgrees !== true
      ? "Stripe's account must print our name first."
      : null;
  return (
    <Sheet
      open
      onClose={onClose}
      title={
        mode === "approve"
          ? `Approve the invoice for ${monthLabel(invoice.month)}`
          : `Send the invoice for ${monthLabel(invoice.month)}`
      }
      subtitle={
        mode === "approve"
          ? "Read it as they will. Approving says it may go; a different admin sends it."
          : `Approved ${by(invoice.approvedByName)} ${fmtDate(invoice.approvedAt)}. Once sent, the amount cannot change.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not yet
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={cannotSend !== null}
            title={cannotSend ?? undefined}
            onClick={onConfirm}
          >
            {mode === "approve" ? "Approve" : "Send"} {money(invoice.amountCents)}
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
          { label: "Issued by", value: invoice.issuerName ?? invoicing.issuer.name },
          {
            label: "Governed by",
            value: (
              <a href={terms} target="_blank" rel="noreferrer" className="underline">
                {terms.replace(/^https?:\/\//, "")}
              </a>
            ),
          },
          {
            label: "Through",
            value: `${invoicing.provider}${invoice.livemode ? "" : " · no real money moves"}${
              invoicing.printed?.name ? `, which prints "${invoicing.printed.name}"` : ""
            }`,
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
      <IssuerNotice invoicing={invoicing} livemode={invoice.livemode} />
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
  const { me } = useAuth();
  const invalidate = [["billing-servicer", slug]] as const;
  const draft = useAct({ invalidate, done: "Drafted" });
  const approve = useAct({ invalidate, done: "Approved" });
  const withdraw = useAct({ invalidate, done: "Approval withdrawn" });
  const send = useAct({ invalidate, done: "Sent" });
  const cancel = useAct({ invalidate, done: "Done" });
  const paid = useAct({ invalidate, done: "Recorded" });
  const sync = useAct({ invalidate, done: "Read again" });
  const toast = useToast();
  const [sheet, setSheet] = useState<
    "approve" | "send" | "withdraw" | "void" | "paid" | "credit" | null
  >(null);

  const live = invoice && invoice.standing !== "void" ? invoice : null;
  const isDraft = live?.atProvider === true && live.standing === "draft";
  const isApproved = live?.atProvider === true && live.standing === "approved";
  const iApproved = isApproved && live.approvedBy !== null && live.approvedBy === me?.staff_user_id;
  const cannotSend = !isApproved
    ? null
    : iApproved
      ? "You approved this invoice; a different admin sends it."
      : live.livemode && invoicing.issuerAgrees !== true
        ? "Stripe's account must print our name before a real invoice is sent."
        : null;
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
  const firstError =
    draft.error ??
    approve.error ??
    withdraw.error ??
    send.error ??
    cancel.error ??
    paid.error ??
    sync.error;

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
          {isDraft ? (
            <>
              <Button variant="primary" onClick={() => setSheet("approve")}>
                Review and approve…
              </Button>
              <Button variant="secondary" onClick={() => setSheet("void")}>
                Discard…
              </Button>
            </>
          ) : null}
          {isApproved ? (
            <>
              <Button
                variant="primary"
                disabled={cannotSend !== null}
                title={cannotSend ?? undefined}
                onClick={() => setSheet("send")}
              >
                Review and send…
              </Button>
              <Button variant="secondary" onClick={() => setSheet("withdraw")}>
                Withdraw approval…
              </Button>
              <Button variant="ghost" onClick={() => setSheet("void")}>
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
          {live &&
          stripeDashboardUrl("invoices", live.providerInvoiceId, live.provider, live.livemode) ? (
            <a
              href={stripeDashboardUrl(
                "invoices",
                live.providerInvoiceId,
                live.provider,
                live.livemode,
              )!}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-md px-3 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg"
            >
              View in Stripe
            </a>
          ) : null}
          {live?.atProvider && !isDraft && !isApproved ? (
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
              ...(isDraft || isApproved
                ? [
                    {
                      label: "Terms",
                      value: live.netDays === 0 ? "Due on receipt" : `Net ${live.netDays}`,
                    },
                  ]
                : [
                    {
                      label: "Remaining",
                      value: money(live.amountRemainingCents),
                    },
                    { label: "Due", value: live.dueAt ? fmtDate(live.dueAt) : "—" },
                  ]),
              ...(live.issuerName ? [{ label: "Issued by", value: live.issuerName }] : []),
              {
                label: "Drafted",
                value: `${fmtDateTime(live.createdAt)} ${by(live.createdByName)}`,
              },
              ...(live.approvedAt
                ? [
                    {
                      label: "Approved",
                      value: `${fmtDateTime(live.approvedAt)} ${by(live.approvedByName)}${
                        iApproved ? " (you)" : ""
                      }`,
                    },
                  ]
                : []),
              ...(live.sentAt
                ? [{ label: "Sent", value: `${fmtDateTime(live.sentAt)} ${by(live.sentByName)}` }]
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
          {isApproved && cannotSend ? (
            <Notice tone="neutral" className="mt-4">
              {cannotSend}
            </Notice>
          ) : null}
          {isDraft || isApproved ? (
            <IssuerNotice invoicing={invoicing} livemode={live.livemode} />
          ) : null}
          {live.atProvider ? <CreditNoteList slug={slug} invoice={live} notes={noteList} /> : null}
        </div>
      ) : cannotDraft && !nothing ? (
        <Notice tone="neutral" className="mt-4">
          {cannotDraft}
        </Notice>
      ) : null}
      {firstError ? (
        <Notice tone="danger" className="mt-4">
          {firstError.message}
        </Notice>
      ) : null}

      {(sheet === "approve" || sheet === "send") && live ? (
        <ReviewSheet
          mode={sheet}
          invoice={live}
          statement={statement}
          profile={profile}
          invoicing={invoicing}
          busy={sheet === "approve" ? approve.busy : send.busy}
          onClose={() => setSheet(null)}
          onConfirm={() =>
            void (sheet === "approve" ? approve : send)
              .run(`/invoices/${live.id}/${sheet}`, { method: "POST", body: {}, door: "billing" })
              .then((ok) => ok && setSheet(null))
          }
        />
      ) : null}
      {sheet === "withdraw" && live ? (
        <ReasonSheet
          title="Withdraw the approval"
          subtitle={`Approved ${by(live.approvedByName)}. The draft stays; it has to be approved again before it is sent.`}
          label="Why"
          button="Withdraw"
          busy={withdraw.busy}
          onClose={() => setSheet(null)}
          onConfirm={(reason) =>
            void withdraw
              .run(`/invoices/${live.id}/approval/withdraw`, {
                method: "POST",
                body: { reason },
                door: "billing",
              })
              .then((ok) => ok && setSheet(null))
          }
        />
      ) : null}
      {sheet === "void" && live ? (
        <ReasonSheet
          title={isDraft || isApproved ? "Discard this draft" : "Void this invoice"}
          subtitle={
            isDraft || isApproved
              ? "Nothing was sent. The month can be drafted again."
              : "It stays on record as voided, and the month can be issued again."
          }
          label="Why"
          button={isDraft || isApproved ? "Discard" : "Void"}
          danger={!(isDraft || isApproved)}
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
