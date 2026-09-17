/**
 * What a credit pull says the borrower owes, written as the rows a casefile
 * carries.
 *
 * The same reconciliation `assets.ts` does for a bank pull, for the
 * tradelines on a credit report: one `du_liabilities` row per tradeline,
 * owed by the person whose report it is, matched in place on a re-pull,
 * retired when a report no longer carries it, never deleted. Desktop
 * Underwriter reads the credit report itself, but the casefile's `LIABILITY`
 * containers are the borrower's statement of what they owe and every shipped
 * sample carries them.
 *
 * What a tradeline becomes, stated:
 *
 *   - **The type is the bureau's kind on DU's list.** A mortgage is a
 *     `MortgageLoan`, a card is `Revolving`, a HELOC is a `HELOC`; an auto
 *     loan, a student loan and any other installment are `Installment`,
 *     because that is what they are and DU's list has no finer name for them.
 *     A tradeline the bureau could not classify is `Other`, with the fixed
 *     description the CHECK requires.
 *   - **No account number.** A credit report carries a tradeline id, which
 *     is the vendor's and not the account's, and the report type carries no
 *     masked number. The identifier is left empty rather than filled with a
 *     string DU would read as one.
 *   - **Excluded means excluded.** A tradeline the reconciliation left out of
 *     DTI with a reason code (CRD-003) is written with the exclusion
 *     indicator set, so the casefile says what the decision did.
 *   - **Nothing is paid off at closing.** That is the borrower's statement on
 *     the URLA and no pull can make it; the column is false until somebody
 *     asks.
 *   - **A mortgage is not tied to a property.** Which owned property secures
 *     which lien is the pairing `du_liabilities.secured_by_owned_property_id`
 *     exists for, and it is a person's call rather than a string match on a
 *     creditor's name.
 *
 * The engine does not read these rows; it reads the snapshot. These are
 * what the submission carries.
 */

import type { Prisma } from "@hm/db";
import { liabilityIdentityKeys, writeLiability } from "@hm/du";
import type { CreditReport, Tradeline } from "@hm/shared";
import type { Db } from "./db.js";

type LiabilityType = Prisma.DuLiabilityUncheckedCreateInput["liabilityType"];

const LIABILITY_TYPE: Record<Tradeline["type"], LiabilityType> = {
  mortgage: "MortgageLoan",
  revolving: "Revolving",
  installment: "Installment",
  auto: "Installment",
  student: "Installment",
  heloc: "HELOC",
  other: "Other",
};

const OTHER_DESCRIPTION = "Tradeline of a kind the credit report does not classify";

const cents = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

export interface ReconciledLiabilities {
  readonly written: number;
  readonly retired: number;
}

export async function reconcileLiabilities(
  tx: Db,
  args: {
    readonly loanFileId: string;
    readonly partyId: string;
    readonly snapshotId: string;
    readonly provider: string;
    readonly reported: Pick<CreditReport, "tradelines">;
    readonly now: Date;
  },
): Promise<ReconciledLiabilities> {
  const { loanFileId, partyId, snapshotId, provider, reported, now } = args;

  const application = await tx.application.findUnique({
    where: { loanFileId },
    select: { id: true },
  });
  if (!application) return { written: 0, retired: 0 };
  const applicationId = application.id;
  const edge = await tx.applicationParty.findUnique({
    where: { applicationId_partyId: { applicationId, partyId } },
    select: { id: true },
  });
  if (!edge) {
    throw new Error(
      `the person whose credit was pulled (party ${partyId}) is not on application ${applicationId}`,
    );
  }

  const touched: string[] = [];
  for (const tradeline of reported.tradelines) {
    const liabilityType = LIABILITY_TYPE[tradeline.type];
    const keys = liabilityIdentityKeys(
      { partyId, provider, itemId: tradeline.id },
      {
        holderName: tradeline.creditorName,
        liabilityType,
        accountIdentifier: null,
        // A Date rather than the string, so the key is the UTC day whatever
        // the vendor's spelling; `identity.ts` refuses any other string.
        openedOn: new Date(tradeline.openedDate),
      },
    );
    touched.push(
      await writeLiability(tx, {
        matchOnIdentity: true,
        priorIdentityKeys: keys.priorKeys,
        obligors: [{ applicationPartyId: edge.id }],
        liability: {
          applicationId,
          liabilityType,
          liabilityTypeOtherDescription: liabilityType === "Other" ? OTHER_DESCRIPTION : null,
          holderName: tradeline.creditorName.slice(0, 150),
          accountIdentifier: null,
          unpaidBalanceCents: cents(tradeline.balance),
          monthlyPaymentCents: cents(tradeline.monthlyPayment),
          payoffStatus: false,
          exclusionIndicator: Boolean(tradeline.exclusionReasonCode),
          helocMaximumBalanceCents:
            liabilityType === "HELOC" && tradeline.creditLimit !== undefined
              ? cents(tradeline.creditLimit)
              : null,
          identityKey: keys.key,
          sourceSnapshotId: snapshotId,
          firstSeenSnapshotId: snapshotId,
          lastSeenSnapshotId: snapshotId,
        },
      }),
    );
  }

  const retired = await tx.duLiability.updateMany({
    where: {
      applicationId,
      identityKey: { startsWith: `p:${partyId}:` },
      retiredAt: null,
      id: { notIn: touched },
    },
    data: { retiredAt: now, retiredBySnapshotId: snapshotId },
  });

  return { written: touched.length, retired: retired.count };
}
