/**
 * Rows to a `DEAL` tree, and the envelope around it.
 *
 * `index.ts` in `packages/du` is assemble → preflight → emit in that order.
 * Preflight is not written yet, so this is assemble → emit, and the emitter can
 * produce a document DU would refuse. That inversion lasts exactly one commit
 * and nothing transports a file inside it.
 *
 * **Nothing here reaches for a clock.** `createdAt` is an argument because the
 * one claim this design makes about reproducibility — two emissions of the same
 * application are byte-identical when no row was created, retired or revived
 * between them — is false the moment a wall-clock read is in the middle of it.
 * The caller supplies the moment the document was made, and the bytes are a
 * function of the database state and that moment.
 */

import { compact, container, leaf, type DuNode } from "../document.js";
import { assertInstitutionEmittable, type DuInstitution } from "../institution.js";
import { createLabelIndex, createLabels } from "../labels.js";
import { renderDateTime } from "../values.js";
import { buildAssets } from "./assets.js";
import { buildCollaterals } from "./collateral.js";
import { buildExpenses, buildLiabilities } from "./liabilities.js";
import { buildLoans } from "./loan.js";
import { buildParties, type TaxpayerIdentifierResolver } from "./parties.js";
import { buildRelationships } from "./relationships.js";
import {
  buildVerifications,
  selectVerifications,
  standingReports,
  VERIFICATION_KINDS,
} from "./verifications.js";
import {
  loadApplication,
  loadAssets,
  loadEmployments,
  loadExpenses,
  loadIncome,
  loadLiabilities,
  loadPartyFacts,
  loadVerificationPayloads,
  loadVerificationSnapshots,
  type DuReader,
} from "./load.js";

/**
 * The envelope, which is the same bytes on every submission.
 *
 * Attribute order matches the eighteen vendored samples. Nothing depends on it
 * — XML attributes are unordered — and a document somebody has to read beside
 * one of Fannie Mae's should not differ from it in ways that are not about the
 * data.
 */
const MESSAGE_ATTRIBUTES = {
  xmlns: "http://www.mismo.org/residential/2009/schemas",
  "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
  "xmlns:ULAD": "http://www.datamodelextension.org/Schema/ULAD",
  "xmlns:DU": "http://www.datamodelextension.org/Schema/DU",
  MISMOReferenceModelIdentifier: "3.4.032420160128",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
  "xsi:schemaLocation": "http://www.mismo.org/residential/2009/schemas DU_Wrapper_3.4.0_B324.xsd",
} as const;

/**
 * Which specification this document is written to.
 *
 * The version the vendored workbook is, not the version the samples carry: the
 * eighteen say "DU Spec 1.9.1" because that is when Fannie Mae shipped them,
 * and the six generated tables an emitter works against were read from 1.9.3.
 * Moving the workbook moves this.
 */
const ABOUT_VERSION_IDENTIFIER = "DU Spec 1.9.3";

/**
 * The party that sends the casefile, which sits outside the `DEAL`.
 *
 * `MESSAGE/DEAL_SETS/PARTIES` is a sibling of `DEAL_SET` and not a child of
 * it, and the Map files exactly two data points there: the role, and the
 * `PartyRoleIdentifier` it calls the Institution ID. So this is the whole of
 * the element — no name, no address, no license — and it is assembled here
 * rather than in `parties.ts`, which builds the deal's own people and would
 * have to be handed a path it never walks.
 *
 * No `xlink:label`. Labels exist so arcs can name a container, the arcs are
 * all inside the deal, and a label nothing points at is a name to keep unique
 * for no reason.
 */
function buildSubmittingParty(institution: DuInstitution): DuNode | null {
  return container("PARTIES", [
    container("PARTY", [
      container("ROLES", [
        container("ROLE", [
          container("PARTY_ROLE_IDENTIFIERS", [
            container("PARTY_ROLE_IDENTIFIER", [
              leaf("PartyRoleIdentifier", institution.submittingPartyIdentifier),
            ]),
          ]),
          container("ROLE_DETAIL", [leaf("PartyRoleType", "SubmittingParty")]),
        ]),
      ]),
    ]),
  ]);
}

export interface AssembleOptions {
  /** The moment this document was made. Not read from a clock; see the header. */
  readonly createdAt: Date;
  /**
   * Whose seller/servicer number this goes under, and what we call the loan.
   *
   * Required rather than defaulted, because a default is how a placeholder
   * becomes a value nobody chose. `assertInstitutionEmittable` is called below
   * before a row is read, and it refuses the placeholders outside development.
   */
  readonly institution: DuInstitution;
  /**
   * Where the nine digits come from, for the length of one emission.
   *
   * Absent, no `TAXPAYER_IDENTIFIER` is written at all. That is the honest
   * shape of "we cannot reach the vault": DU requires the element, the document
   * is short one, and the preflight is what will say so — as against writing
   * `ssn_last4` with five digits in front of it, which would be a federal
   * submission carrying a made-up number that nothing downstream could tell
   * from a real one.
   */
  readonly taxpayerIdentifiers?: TaxpayerIdentifierResolver;
}

/** The whole `MESSAGE`, as a tree. `emitDocument` is what turns it into bytes. */
export async function assembleSubmission(
  db: DuReader,
  applicationId: string,
  options: AssembleOptions,
): Promise<DuNode> {
  // Before a row is read, because a casefile assembled against an institution
  // nobody may submit under is work done to produce bytes that must not exist.
  assertInstitutionEmittable(options.institution);

  const application = await loadApplication(db, applicationId);
  if (!application) throw new Error(`No application ${applicationId} to assemble.`);

  const [assets, liabilities, expenses, income, employments, facts, snapshots] = await Promise.all([
    loadAssets(db, applicationId),
    loadLiabilities(db, applicationId),
    loadExpenses(db, applicationId),
    loadIncome(db, application.loanFile.id),
    loadEmployments(db, application.loanFile.id),
    loadPartyFacts(
      db,
      application.parties.map((party) => party.partyId),
    ),
    loadVerificationSnapshots(
      db,
      application.loanFile.id,
      application.parties.map((party) => party.partyId),
      VERIFICATION_KINDS,
    ),
  ]);
  // Decided before anything is built, because the container hangs off the loan
  // and the arcs are folded after the roles exist, and both have to be the same
  // set of reports.
  //
  // Two reads and not one: the history above is unbounded — a re-pull a day for
  // a year is hundreds of rows a borrower — and the payloads are wanted only for
  // the handful that stand, which is at most one per report type per borrower.
  const standing = standingReports(snapshots, application);
  const verifications = selectVerifications(
    standing,
    await loadVerificationPayloads(
      db,
      standing.map((report) => report.snapshotId),
    ),
  );

  const labels = createLabels();
  const index = createLabelIndex();

  // Built in the order the labels are numbered in, which is the order `DEAL`
  // writes them: a reader following the document down finds ASSET_1 before
  // ASSET_2 and BORROWER_1 before BORROWER_2.
  const assetsNode = buildAssets(assets, application, labels, index);
  const collateralsNode = buildCollaterals(application);
  const expensesNode = buildExpenses(expenses, labels, index);
  const liabilitiesNode = buildLiabilities(liabilities, labels, index);
  const loansNode = buildLoans(
    application,
    buildVerifications(verifications, labels, index),
    options.institution,
  );
  const partiesNode = await buildParties({
    application,
    facts,
    income,
    employments,
    labels,
    index,
    ...(options.taxpayerIdentifiers ? { taxpayerIdentifiers: options.taxpayerIdentifiers } : {}),
  });
  const relationshipsNode = buildRelationships({
    application,
    assets,
    liabilities,
    expenses,
    income,
    verifications,
    index,
  });

  const deal = container("DEAL", [
    assetsNode,
    collateralsNode,
    expensesNode,
    liabilitiesNode,
    loansNode,
    partiesNode,
    relationshipsNode,
  ]);

  return {
    name: "MESSAGE",
    attributes: MESSAGE_ATTRIBUTES,
    children: compact([
      container("ABOUT_VERSIONS", [
        container("ABOUT_VERSION", [
          leaf("AboutVersionIdentifier", ABOUT_VERSION_IDENTIFIER),
          leaf("CreatedDatetime", renderDateTime(options.createdAt)),
        ]),
      ]),
      container("DEAL_SETS", [
        container("DEAL_SET", [container("DEALS", [deal])]),
        buildSubmittingParty(options.institution),
      ]),
    ]),
  };
}

export type { TaxpayerIdentifierResolver } from "./parties.js";
export type { DuReader } from "./load.js";
export type { DuInstitution } from "../institution.js";
