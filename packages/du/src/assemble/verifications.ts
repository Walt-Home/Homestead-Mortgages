/**
 * `DU:UNDERWRITING_VERIFICATION`: which vendor report DU may rely on, and for
 * whom.
 *
 * **One verification per (report type, party). Never the history.**
 * `connector_snapshots` is append-only — a re-pull writes a new row, nothing
 * overwrites one, and the table has no `retired_at` — so the naive reading
 * emits one element per snapshot. Two borrowers resubmitted six times with
 * bank, payroll and IRS re-pulled each round is **thirty-six** elements, nine
 * of them stale VODs naming report identifiers a later pull superseded, and a
 * longer file crosses this container's maximum of fifty and is rejected on
 * cardinality before anybody reads a number in it.
 *
 * A verification is DU's statement of what it may rely on **now**, not a log of
 * what we pulled. So this is the one place an append-only table is deliberately
 * read non-exhaustively: the whole history stays in the table, where the
 * monitoring loop's "your situation changed" diff needs a row it can diff
 * against, and none of it reaches the wire.
 *
 * **Only the `ROLE` variant is built.** The `ASSET` and `EMPLOYER` arcs name
 * one element in their endpoint rows and a different one in their arcrole URIs
 * — `OWNED_PROPERTY_DETAIL` against `ASSET`, `EMPLOYMENT` against `EMPLOYER` —
 * and `generated/arcroles.ts` marks both ends `disputed` and picks no winner.
 * Both constructions validate against the whole nine-file chain and neither
 * appears in any of the eighteen shipped samples, so guessing produces a
 * document that is accepted and misread, which is worse than one that was never
 * written. `arcrole` in `relationships.ts` refuses a disputed name outright, so
 * the refusal holds for whatever folds an arc rather than only for the folds
 * written today.
 */

import { container, leaf, type DuNode } from "../document.js";
import { type DuLabelIndex, type DuLabels, verificationKey } from "../labels.js";
import { renderCount } from "../values.js";
import type { LoadedVerificationSnapshot } from "./load.js";

/**
 * Our snapshot kinds, as DU's report types.
 *
 * All nine kinds are named and six of them are named as nothing, because
 * "unmapped by mistake" and "deliberately not a verification" must not look
 * alike. `credit` and `sanctions` are about a person and are not verification
 * reports; the four address-keyed kinds carry no party at all, which the
 * snapshot table's own trigger already refuses to let them do. `IncomeCalculator`
 * is the fourth member of DU's list and no kind here produces one — nothing in
 * this repository computes income for DU to rely on, so there is no report to
 * name.
 *
 * Nine is the trigger's number, not a number chosen here: a kind the database
 * admits and this map has never heard of would be a verification missing from a
 * federal submission with nothing to say so. A test reads the kinds out of
 * `connector_snapshots_say_whose_they_are` and fails when the two lists differ,
 * and `standingReports` throws rather than skipping if one reaches it anyway.
 */
export const VERIFICATION_REPORT_TYPE: Readonly<Record<string, string | null>> = {
  bank: "VOD",
  payroll: "VOE",
  irs: "TAXTRANSCRIPT",
  credit: null,
  sanctions: null,
  property_record: null,
  valuation: null,
  flood: null,
  lien_search: null,
};

/**
 * The same table, as a lookup that answers "never heard of it".
 *
 * A `Map` rather than the object above because `kind` is a column and an object
 * answers `constructor` and `toString` with something truthy — which would make
 * a row nobody decided about into a report type nobody chose. Here a miss is
 * `undefined` and nothing else is.
 */
const REPORT_TYPE_BY_KIND = new Map(Object.entries(VERIFICATION_REPORT_TYPE));

/** The kinds worth reading out of the table at all. */
export const VERIFICATION_KINDS: readonly string[] = Object.entries(VERIFICATION_REPORT_TYPE)
  .filter(([, reportType]) => reportType !== null)
  .map(([kind]) => kind);

/**
 * DU's approved validation service providers, and what each is called on the
 * wire.
 *
 * Keyed by the exact string `connector_snapshots.provider` carries, because
 * every other reading of that column is a parse: `plaid-cra (production)` and
 * `plaid-assets (sandbox)` differ by the product, and the product is the whole
 * of what is approved. **A provider with no row here emits no verification** —
 * `DU:VerificationReportSupplierType` is required the moment a report
 * identifier exists, so there would be nothing to write — which makes a vendor
 * leaving or joining the list a row rather than a rewrite.
 *
 * Plaid's consumer-report product is on that list. Its assets product is the
 * same client against the same account and is not a consumer report, which is
 * why only one of the two is here.
 *
 * The fixtures are here because they are the only payroll and transcript
 * suppliers this repository has, and a submission assembled from them says
 * `Fixture` rather than borrowing a real vendor's name for numbers that vendor
 * never produced.
 */
const VERIFICATION_REPORT_SUPPLIER: Readonly<Record<string, string>> = {
  "plaid-cra (production)": "Plaid",
  "plaid-cra (sandbox)": "Plaid",
  "fixture-bank": "Fixture",
  "fixture-payroll": "Fixture",
  "fixture-irs": "Fixture",
};

/** The same table, as a lookup where a miss is a miss. As above, for the same reason. */
const SUPPLIER_BY_PROVIDER = new Map(Object.entries(VERIFICATION_REPORT_SUPPLIER));

/**
 * The report's own answer, where it has one.
 *
 * An asset report carries `vendorAuthorizedForDu`, and that is a statement
 * about the report rather than about the vendor: the same Plaid client on the
 * same account sets it true from the consumer-report product and false from the
 * assets one. A false there withdraws what the table above grants, because
 * naming a supplier the report itself disclaims puts a claim on a federal
 * submission that nobody made.
 */
function reportDisclaimsAuthorization(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  return (payload as Record<string, unknown>).vendorAuthorizedForDu === false;
}

/**
 * The whole of the application a selection reads.
 *
 * Structural rather than the loaded row, because the only question asked of it
 * is which borrowing edge a party is: the order of these is the order the
 * `ROLE` labels are minted in, and a report about somebody not among them has
 * nowhere in the document to arc to.
 */
interface VerificationParties {
  readonly parties: readonly { readonly id: string; readonly partyId: string }[];
}

/**
 * One report that stands, before its own payload has been read.
 *
 * The snapshot id is here because the payload is fetched over these and nothing
 * wider: the gate needs one boolean per standing report, and the history it was
 * chosen from can be a year of daily pulls.
 */
export interface StandingReport {
  readonly snapshotId: string;
  readonly reportType: string;
  readonly provider: string;
  readonly reportIdentifier: string;
  /** The `application_parties` row, because the arc ends at a part in this deal. */
  readonly applicationPartyId: string;
}

/** One verification element, and the role its arc ends at. */
export interface SelectedVerification {
  readonly reportType: string;
  readonly supplier: string;
  readonly reportIdentifier: string;
  /** The `application_parties` row, because the arc ends at a part in this deal. */
  readonly applicationPartyId: string;
}

/**
 * Report type order, by code unit and not by the host's collation.
 *
 * `localeCompare` would make the element order — and therefore every
 * `SequenceNumber` in the document — a property of the machine the emitter ran
 * on. Nothing reorders TAXTRANSCRIPT, VOD and VOE today; the point is that
 * nothing can.
 */
function compareReportType(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The reports that stand, from the whole history of pulls.
 *
 * The snapshots arrive newest first — `retrieved_at` and then the write order,
 * so two pulls the vendor stamped with one millisecond are separated by which
 * of them was written second — and the first row seen for a pair is the one
 * that stands. Every later one is history.
 *
 * A pair is closed the moment its newest row is seen, and the vendor gate runs
 * afterwards over what this kept: a borrower whose latest bank pull came from
 * an unauthorized product has no verification, not a superseded one dressed up
 * as current.
 *
 * The order out is report type, then the borrower's position on the file, which
 * is the order the labels are minted in and the order the arcs are folded in.
 * Both are total — one row per pair, and a pair cannot repeat.
 */
export function standingReports(
  snapshots: readonly LoadedVerificationSnapshot[],
  application: VerificationParties,
): StandingReport[] {
  const edgeByParty = new Map(
    application.parties.map((party, position) => [
      party.partyId,
      { applicationPartyId: party.id, position },
    ]),
  );

  const seen = new Set<string>();
  const standing: (StandingReport & { readonly position: number })[] = [];
  for (const snapshot of snapshots) {
    const reportType = REPORT_TYPE_BY_KIND.get(snapshot.kind);
    // Refused rather than skipped. The database raises on a kind it has never
    // heard of precisely so that adding one is somebody's decision; a kind that
    // got past it and not past this map is a report DU should have been told
    // about, and dropping it quietly is how a submission goes out short a
    // verification with nothing anywhere saying so.
    if (reportType === undefined) {
      throw new Error(
        `${snapshot.kind} is a snapshot kind with no decision about whether it is a verification report.`,
      );
    }
    if (reportType === null) continue;
    // The column is nullable because the address-keyed kinds must not name a
    // party, and the loader already asks for rows whose party is one of this
    // application's. This is what tells the type checker so.
    if (snapshot.partyId === null) continue;
    const edge = edgeByParty.get(snapshot.partyId);
    if (!edge) continue;

    const pair = verificationKey(reportType, edge.applicationPartyId);
    if (seen.has(pair)) continue;
    seen.add(pair);

    standing.push({
      snapshotId: snapshot.id,
      reportType,
      provider: snapshot.provider,
      reportIdentifier: snapshot.externalId,
      applicationPartyId: edge.applicationPartyId,
      position: edge.position,
    });
  }

  return standing
    .sort((a, b) => compareReportType(a.reportType, b.reportType) || a.position - b.position)
    .map(({ position: _position, ...report }) => report);
}

/**
 * The reports a submission may name, of the reports that stand.
 *
 * Two gates, and a report has to pass both: DU's list of approved validation
 * service providers, and the report's own statement about itself. Either one
 * failing emits no verification at all rather than one missing its supplier —
 * `DU:VerificationReportSupplierType` is required the moment a report
 * identifier exists.
 */
export function selectVerifications(
  standing: readonly StandingReport[],
  payloads: ReadonlyMap<string, unknown>,
): SelectedVerification[] {
  const selected: SelectedVerification[] = [];
  for (const report of standing) {
    if (reportDisclaimsAuthorization(payloads.get(report.snapshotId))) continue;
    const supplier = SUPPLIER_BY_PROVIDER.get(report.provider);
    if (supplier === undefined) continue;
    selected.push({
      reportType: report.reportType,
      supplier,
      reportIdentifier: report.reportIdentifier,
      applicationPartyId: report.applicationPartyId,
    });
  }
  return selected;
}

/**
 * The `EXTENSION` block a `LOAN` carries its verifications in, or nothing when
 * no report stands.
 *
 * The label goes on the verification and the index files it under the pair it
 * was selected for, so the arc fold can find it after the `ROLE` labels exist.
 */
export function buildVerifications(
  selected: readonly SelectedVerification[],
  labels: DuLabels,
  index: DuLabelIndex,
): DuNode | null {
  const nodes = selected.map((verification, position) => {
    const label = labels.next("verification");
    index.verificationByReportTypeAndParty.set(
      verificationKey(verification.reportType, verification.applicationPartyId),
      label,
    );
    return container(
      "DU:UNDERWRITING_VERIFICATION",
      [
        leaf("DU:VerificationReportIdentifier", verification.reportIdentifier),
        leaf("DU:VerificationReportSupplierType", verification.supplier),
        leaf("DU:VerificationReportType", verification.reportType),
      ],
      { SequenceNumber: renderCount(position + 1), "xlink:label": label },
    );
  });

  return container("EXTENSION", [
    container("OTHER", [
      container("DU:LOAN_EXTENSION", [container("DU:UNDERWRITING_VERIFICATIONS", nodes)]),
    ]),
  ]);
}
