/**
 * A household's reports, read the way the engine has to read them.
 *
 * A loan with two borrowers carries two credit reports, two asset reports and
 * two sets of transcripts, and the numbers on the decision are about the loan
 * rather than about one of the people on it: every borrower's debts are in
 * the DTI, every borrower's accounts are reserves, and the score the minimum
 * is tested against is computed from all of them (Selling Guide B3-5.1-02).
 * The file-level `credit`, `assets`, `payroll` and `transcripts` are Borrower
 * 1's, by party, because the screens read them that way; nothing that
 * computes reads them directly any more. It reads these.
 *
 * Two rules the helpers hold, so every caller holds them:
 *
 *   1. **A joint account is one account.** A liability on both borrowers'
 *      credit reports is one obligation, and DI-C09 in the DU corpus is one
 *      `LIABILITY` with two obligors; a joint deposit account on both asset
 *      reports is one balance. Counting either twice overstates the debt or
 *      the reserves by exactly the amount that was shared. What "the same
 *      account" means is `tradelineKey` and `accountKey`, and the count of
 *      what they folded is returned beside the result so a derivation can
 *      say so.
 *   2. **A missing report is named, not defaulted.** A member with no credit
 *      report is in `withoutCredit`; the arithmetic that needs everybody's
 *      report blocks and names them, rather than computing a loan-level
 *      figure from one person's report and calling it the loan's.
 *
 * A file assembled without `reports` — in memory, or before the projection
 * carried them — is read as Borrower 1's: the four file-level fields are
 * theirs, and anybody else on it has no report known. That is exactly what
 * every such file was, and a second person on it blocks rather than borrows.
 */

import type {
  Borrower,
  BorrowerReports,
  DepositAccount,
  LoanFile,
  PublicRecord,
  Tradeline,
} from "./types/index.js";

export interface HouseholdMember {
  /** Null only for a file assembled in memory with no borrower on it yet. */
  readonly partyId: string | null;
  /** How a derivation or an outstanding item names this person. */
  readonly name: string;
  readonly borrower: Borrower | null;
  readonly credit: BorrowerReports["credit"];
  readonly assets: BorrowerReports["assets"];
  readonly payroll: BorrowerReports["payroll"];
  readonly transcripts: BorrowerReports["transcripts"];
}

const nameOf = (b: Borrower): string => `${b.firstName} ${b.lastName}`.trim() || "the borrower";

/** Every borrower on the file with their own reports, in document order. */
export function household(file: LoanFile): readonly HouseholdMember[] {
  if (file.reports) {
    const reports = file.reports;
    return file.borrowers.map((b) => {
      const own = reports.find((r) => r.partyId === b.partyId);
      return {
        partyId: b.partyId,
        name: nameOf(b),
        borrower: b,
        credit: own?.credit ?? null,
        assets: own?.assets ?? null,
        payroll: own?.payroll ?? null,
        transcripts: own?.transcripts ?? [],
      };
    });
  }
  const first = file.borrowers[0] ?? null;
  return [
    {
      partyId: first?.partyId ?? null,
      name: first ? nameOf(first) : "the borrower",
      borrower: first,
      credit: file.credit,
      assets: file.assets,
      payroll: file.payroll,
      transcripts: file.transcripts,
    },
    ...file.borrowers.slice(1).map((b) => ({
      partyId: b.partyId,
      name: nameOf(b),
      borrower: b,
      credit: null,
      assets: null,
      payroll: null,
      transcripts: [],
    })),
  ];
}

/** One borrower's own reports, and nobody else's. */
export function memberFor(file: LoanFile, borrower: Borrower): HouseholdMember {
  const found = household(file).find((m) => m.partyId === borrower.partyId);
  return (
    found ?? {
      partyId: borrower.partyId,
      name: nameOf(borrower),
      borrower,
      credit: null,
      assets: null,
      payroll: null,
      transcripts: [],
    }
  );
}

/**
 * What makes two tradelines the same account. The vendor's `id` is per
 * report, so a joint account carries two of them; what both reports agree on
 * is who the creditor is, what kind of line it is and when it was opened.
 */
export function tradelineKey(t: Tradeline): string {
  return `${t.creditorName.trim().toLowerCase()}|${t.type}|${t.openedDate}`;
}

/** What makes two deposit accounts the same account: the institution and the number's last digits. */
export function accountKey(a: DepositAccount): string {
  return `${a.institution.trim().toLowerCase()}|${a.type}|${a.mask}`;
}

export interface HouseholdTradelines {
  /** Every distinct tradeline across the household, first appearance kept. */
  readonly tradelines: readonly Tradeline[];
  /** How many a second report repeated, and were counted once. */
  readonly deduplicated: number;
  readonly withCredit: readonly HouseholdMember[];
  readonly withoutCredit: readonly HouseholdMember[];
}

export function householdTradelines(file: LoanFile): HouseholdTradelines {
  const members = household(file);
  const withCredit = members.filter((m) => m.credit !== null);
  const seen = new Set<string>();
  const tradelines: Tradeline[] = [];
  let deduplicated = 0;
  for (const m of withCredit) {
    for (const t of m.credit!.tradelines) {
      const key = tradelineKey(t);
      if (seen.has(key)) {
        deduplicated += 1;
        continue;
      }
      seen.add(key);
      tradelines.push(t);
    }
  }
  return {
    tradelines,
    deduplicated,
    withCredit,
    withoutCredit: members.filter((m) => m.credit === null),
  };
}

export interface HouseholdAccounts {
  readonly accounts: readonly DepositAccount[];
  readonly deduplicated: number;
  readonly withAssets: readonly HouseholdMember[];
  readonly withoutAssets: readonly HouseholdMember[];
}

export function householdAccounts(file: LoanFile): HouseholdAccounts {
  const members = household(file);
  const withAssets = members.filter((m) => m.assets !== null);
  const seen = new Set<string>();
  const accounts: DepositAccount[] = [];
  let deduplicated = 0;
  for (const m of withAssets) {
    for (const a of m.assets!.accounts) {
      const key = accountKey(a);
      if (seen.has(key)) {
        deduplicated += 1;
        continue;
      }
      seen.add(key);
      accounts.push(a);
    }
  }
  return {
    accounts,
    deduplicated,
    withAssets,
    withoutAssets: members.filter((m) => m.assets === null),
  };
}

export interface HouseholdPublicRecord {
  readonly record: PublicRecord;
  readonly member: HouseholdMember;
}

/** Every public record on any borrower's report, with whose it is. */
export function householdPublicRecords(file: LoanFile): readonly HouseholdPublicRecord[] {
  return household(file).flatMap((member) =>
    (member.credit?.publicRecords ?? []).map((record) => ({ record, member })),
  );
}
