/**
 * How a servicer pays: ACH debit from a bank account they put on file at
 * the provider, and nothing else. This shows what is on file and makes
 * the link to the provider's hosted page where the account is entered and
 * verified — the number never reaches us. The servicer's portal has the
 * same page behind its own button; the link here is for handing over.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Notice, Pill, Rows } from "./ui.js";
import { Loading } from "./Loading.js";
import { useToast } from "./Toast.js";
import { useAct } from "../lib/act.js";
import { fmtDate, fmtDateTime } from "../lib/format.js";
import {
  billing,
  type BankAccountsAnswer,
  type BankSetupLink,
  type InvoicingStanding,
  type ProfileGap,
} from "../lib/billing.js";

export function AchPayments({
  slug,
  gaps,
  invoicing,
}: {
  slug: string;
  gaps: readonly ProfileGap[];
  invoicing: InvoicingStanding;
}) {
  const toast = useToast();
  const ach = useQuery({
    queryKey: ["billing-ach", slug],
    queryFn: () => billing<BankAccountsAnswer>(`/servicers/${slug}/ach`),
  });
  const make = useAct({
    invalidate: [
      ["billing-ach", slug],
      ["billing-servicer", slug],
    ],
  });
  const [link, setLink] = useState<BankSetupLink | null>(null);
  const needsProfile = gaps.includes("legal_name") || gaps.includes("billing_email");
  const cannot = !invoicing.canIssue
    ? invoicing.cannotIssueBecause
    : needsProfile
      ? "The billing profile needs the legal name and where the invoice goes first."
      : null;

  const create = async () => {
    const made = await make.run<BankSetupLink>(`/servicers/${slug}/ach/setup-link`, {
      method: "POST",
      body: {},
      door: "billing",
    });
    if (made) setLink(made);
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast({ tone: "ok", title: "Link copied" });
    } catch {
      toast({ tone: "neutral", title: "Select the link and copy it" });
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-line-2 bg-surface p-4">
      <p className="text-sm text-fg-2">
        Invoices are paid by ACH debit from a bank account the servicer puts on file with{" "}
        {invoicing.provider.split(" ")[0]}. Cards are not accepted. The account number is held by
        the provider and never by us.
      </p>
      {ach.isPending ? (
        <Loading what="Reading what is on file" />
      ) : ach.isError ? (
        <Notice tone="danger">What is on file could not be read.</Notice>
      ) : ach.data.accounts.length === 0 ? (
        <Notice tone={ach.data.customer ? "warn" : "neutral"} title="No bank account on file">
          {ach.data.customer
            ? "The provider knows this servicer as a customer, and no account has been put on file yet."
            : "The provider does not know this servicer as a customer yet; making a setup link introduces them."}
        </Notice>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line-2">
          {ach.data.accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="flex flex-col">
                <span className="font-medium text-fg">
                  {a.bankName ?? "Bank account"}
                  {a.last4 ? <span className="ml-2 font-mono text-fg-2">····{a.last4}</span> : null}
                </span>
                <span className="text-xs text-fg-3">
                  {[a.accountType, a.holderType].filter(Boolean).join(" · ")}
                  {a.addedAt ? ` · added ${fmtDate(a.addedAt)}` : ""}
                </span>
              </span>
              {a.isDefault ? <Pill tone="ok">Invoices are paid from this</Pill> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={ach.data && ach.data.accounts.length > 0 ? "secondary" : "primary"}
          loading={make.busy}
          disabled={cannot !== null}
          title={cannot ?? undefined}
          onClick={() => void create()}
        >
          {ach.data && ach.data.accounts.length > 0
            ? "Make a link to add another"
            : "Make a setup link"}
        </Button>
        <span className="text-xs text-fg-3">
          Their team can also do this themselves from the portal's billing page.
        </span>
      </div>
      {cannot && !make.busy ? <Notice tone="neutral">{cannot}</Notice> : null}
      {make.error ? <Notice tone="danger">{make.error.message}</Notice> : null}
      {link ? (
        <div className="rounded-lg border border-line-2 bg-surface-2 p-3">
          <Rows
            rows={[
              { label: "Setup link", value: link.url, mono: true },
              { label: "Good until", value: fmtDateTime(link.expiresAt) },
            ]}
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void copy()}>
              Copy link
            </Button>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-md px-3 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg"
            >
              Open it
            </a>
          </div>
          <p className="mt-2 text-xs text-fg-3">
            Send this to the person at the servicer who holds the bank account. It opens the
            provider's page, where they sign in to their bank or confirm two small deposits.
          </p>
        </div>
      ) : null}
    </div>
  );
}
