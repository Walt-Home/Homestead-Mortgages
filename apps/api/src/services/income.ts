/**
 * What one report says about one party's income, reconciled against what the
 * file already holds.
 *
 * This replaces four structural copies of delete-every-row-and-recreate-them.
 * Desktop Underwriter expects to recognize the same income across the three to
 * six submissions of one loan, and it links income items to employers as
 * first-class entities; rows that take a new primary key on every pull can be
 * matched to nothing. So a reported row is UPDATED IN PLACE and keeps its id,
 * a row the report stops naming is RETIRED rather than deleted — you cannot
 * diff against a row you deleted — and a retired identity a later report names
 * again is REVIVED on the same row, because income that goes away and comes
 * back is one income.
 *
 * Everything here is scoped to (file, party). The rows are per file on purpose:
 * `continuanceEstablished` is INC-027's judgment about THIS loan and
 * `evidenceDocumentIds` names documents on THIS file, so sharing one set across
 * a party's two open applications would let one file's underwriting silently
 * move the other's numbers. Only the employer they point at is shared, because
 * an employer is a thing in the world.
 */

import type { EmploymentRecord, IncomeSource } from "@hm/shared";
import type { Db } from "./db.js";
import {
  einDigits,
  employerForIncome,
  employerIdentityKey,
  employerNameKey,
  incomeIdentityKey,
} from "./employer-identity.js";

export interface ReportedIncome {
  readonly incomeSources: readonly IncomeSource[];
  readonly employments: readonly EmploymentRecord[];
}

export interface Reconciliation {
  readonly employerIds: readonly string[];
  readonly matched: number;
  readonly added: number;
  readonly retired: number;
  readonly promotedEmployers: number;
}

/**
 * Find or create this party's employer, promoting a name-derived row to its EIN
 * when a pull finally carries one.
 *
 * The bank path never carries an EIN and the payroll path does, so the same job
 * arrives keyed by name and then keyed by EIN. Promotion — same row, new key —
 * rather than a second row is what keeps the job's identity across that
 * upgrade, which is the one step whose entire purpose is better data about the
 * employer already on file.
 *
 * The promotion has to be survivable in the other direction too, which is what
 * `nameKey` is for. A borrower who re-runs the bank step after payroll sends a
 * report with no EIN, and matching only on `identityKey` would find nothing on
 * a row already moved to `ein:` — opening a second employer for one job and
 * giving its income and employment rows new primary keys on the resubmission,
 * which is the loss this whole file exists to prevent. So the fallback is by
 * name in both directions: an EIN improves a row's key, it never hides the row
 * from the path that has no EIN.
 */
export async function employerFor(
  tx: Db,
  args: {
    readonly partyId: string;
    readonly record: EmploymentRecord;
    readonly snapshotId: string;
  },
): Promise<{ readonly id: string; readonly promoted: boolean }> {
  const { key, derivedFrom } = employerIdentityKey(args.record);
  const nameKey = employerNameKey(args.record.employerName);
  const existing = await tx.employer.findUnique({
    where: { partyId_identityKey: { partyId: args.partyId, identityKey: key } },
    select: { id: true },
  });
  if (existing) {
    await tx.employer.update({
      where: { id: existing.id },
      data: { displayName: args.record.employerName },
    });
    return { id: existing.id, promoted: false };
  }

  // Oldest first, because `nameKey` is not unique and the answer has to be the
  // same one on every pull.
  const sharingName = await tx.employer.findMany({
    where: { partyId: args.partyId, nameKey },
    select: { id: true, derivedFrom: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  if (derivedFrom === "ein") {
    // Only a row that has never been promoted. A row already carrying some
    // OTHER employer's EIN is a different employer that happens to trade under
    // the same name, and overwriting its EIN would merge the two.
    const unpromoted = sharingName.find((e) => e.derivedFrom === "name");
    if (unpromoted) {
      await tx.employer.update({
        where: { id: unpromoted.id },
        data: {
          identityKey: key,
          derivedFrom: "ein",
          ein: einDigits(args.record.employerEin),
          displayName: args.record.employerName,
        },
      });
      return { id: unpromoted.id, promoted: true };
    }
  } else if (sharingName[0]) {
    // The report has no EIN and this row does: the row's key stays the better
    // one, and this pull simply joins it.
    await tx.employer.update({
      where: { id: sharingName[0].id },
      data: { displayName: args.record.employerName },
    });
    return { id: sharingName[0].id, promoted: false };
  }

  const created = await tx.employer.create({
    data: {
      partyId: args.partyId,
      identityKey: key,
      nameKey,
      derivedFrom,
      ein: derivedFrom === "ein" ? einDigits(args.record.employerEin) : null,
      displayName: args.record.employerName,
      firstSeenSnapshotId: args.snapshotId,
    },
    select: { id: true },
  });
  return { id: created.id, promoted: false };
}

/**
 * Reconcile what one report says about one party's income against what this
 * file already holds.
 *
 * `tx` is first and has no default because this write is never legitimate
 * outside the pull's own transaction: the report, what it says about income,
 * and the move it implies are one act.
 */
export async function reconcileIncomeAndEmployment(
  tx: Db,
  args: {
    readonly loanFileId: string;
    readonly partyId: string;
    readonly snapshotId: string;
    readonly reported: ReportedIncome;
    readonly now: Date;
  },
): Promise<Reconciliation> {
  const { loanFileId, partyId, snapshotId, reported, now } = args;
  const seen = { matched: 0, added: 0, promotedEmployers: 0 };

  // Employers first: an income row's identity is built out of its employer's
  // primary key, so the employer has to exist before the key can be derived.
  const employerIds: string[] = [];
  const activeEmployerIds: string[] = [];
  const employmentRows: { employerId: string; record: EmploymentRecord }[] = [];
  for (const record of reported.employments) {
    const employer = await employerFor(tx, { partyId, record, snapshotId });
    if (employer.promoted) seen.promotedEmployers += 1;
    if (employerIds.includes(employer.id)) {
      // Two spells at one employer collapse into one row. The vendor gives one
      // employer name per record and no spell boundaries, so there is nothing
      // to tell them apart with, and the unique key would refuse the second.
      continue;
    }
    employerIds.push(employer.id);
    if (record.status === "active") activeEmployerIds.push(employer.id);
    employmentRows.push({ employerId: employer.id, record });
  }

  const existingEmployments = await tx.employment.findMany({
    where: { loanFileId, partyId },
    select: { id: true, employerId: true },
  });
  const employmentByEmployer = new Map(
    existingEmployments.filter((e) => e.employerId).map((e) => [e.employerId!, e.id]),
  );

  const touchedEmployments: string[] = [];
  for (const { employerId, record } of employmentRows) {
    const fields = {
      employerId,
      employerName: record.employerName,
      employerEin: record.employerEin ?? null,
      position: record.position,
      startDate: record.startDate ? new Date(record.startDate) : null,
      endDate: record.endDate ? new Date(record.endDate) : null,
      status: record.status,
      isMilitary: record.isMilitary,
      verificationMethod: record.verificationMethod,
      lastSeenSnapshotId: snapshotId,
    };
    const existingId = employmentByEmployer.get(employerId);
    if (existingId) {
      // Revival is the `retiredAt: null` here: an identity this report names
      // again is the same job, not a new one.
      await tx.employment.update({
        where: { id: existingId },
        data: { ...fields, retiredAt: null, retiredBySnapshotId: null },
      });
      touchedEmployments.push(existingId);
      seen.matched += 1;
    } else {
      const created = await tx.employment.create({
        data: { ...fields, loanFileId, partyId, firstSeenSnapshotId: snapshotId },
        select: { id: true },
      });
      touchedEmployments.push(created.id);
      seen.added += 1;
    }
  }

  const existingIncome = await tx.incomeSource.findMany({
    where: { loanFileId, partyId },
    select: { id: true, identityKey: true },
  });
  const incomeByKey = new Map(existingIncome.map((s) => [s.identityKey, s.id]));

  const touchedIncome: string[] = [];
  const ordinals = new Map<string, number>();
  for (const source of reported.incomeSources) {
    const employerId = employerForIncome(source.type, activeEmployerIds);
    const base = incomeIdentityKey({ type: source.type, employerId, ordinal: 1 });
    const ordinal = (ordinals.get(base) ?? 0) + 1;
    ordinals.set(base, ordinal);
    const identityKey = incomeIdentityKey({ type: source.type, employerId, ordinal });

    const fields = {
      employerId,
      type: source.type,
      monthlyAmount: source.monthlyAmount,
      historyMonths: source.historyMonths,
      continuanceEndDate: source.continuanceEndDate ? new Date(source.continuanceEndDate) : null,
      continuanceEstablished: source.continuanceEstablished,
      evidenceDocumentIds: [...source.evidenceDocumentIds],
      lastSeenSnapshotId: snapshotId,
    };
    const existingId = incomeByKey.get(identityKey);
    if (existingId) {
      await tx.incomeSource.update({
        where: { id: existingId },
        data: { ...fields, retiredAt: null, retiredBySnapshotId: null },
      });
      touchedIncome.push(existingId);
      seen.matched += 1;
    } else {
      const created = await tx.incomeSource.create({
        data: { ...fields, loanFileId, partyId, identityKey, firstSeenSnapshotId: snapshotId },
        select: { id: true },
      });
      touchedIncome.push(created.id);
      seen.added += 1;
    }
  }

  // The retirement and its cause are one statement, so a retired row always
  // names the report that retired it.
  const retiredIncome = await tx.incomeSource.updateMany({
    where: { loanFileId, partyId, retiredAt: null, id: { notIn: touchedIncome } },
    data: { retiredAt: now, retiredBySnapshotId: snapshotId },
  });
  const retiredEmployment = await tx.employment.updateMany({
    where: { loanFileId, partyId, retiredAt: null, id: { notIn: touchedEmployments } },
    data: { retiredAt: now, retiredBySnapshotId: snapshotId },
  });

  return {
    employerIds,
    matched: seen.matched,
    added: seen.added,
    retired: retiredIncome.count + retiredEmployment.count,
    promotedEmployers: seen.promotedEmployers,
  };
}
