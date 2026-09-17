/**
 * Who originates, on every application from the moment it exists.
 *
 * The origination company and the loan originator are two `du_deal_parties`
 * rows, and they are written at application birth — inside
 * `createDraftApplication` — because a casefile with a borrower-only
 * `PARTIES` is one the preflight refuses, and the numbers do not change from
 * one application to the next. They come from configuration, and where the
 * configuration is silent they are the placeholders `packages/du` defines:
 * values with letters in them that no NMLSR id has, refused at assembly in
 * production. The refusal is at assembly rather than here, the way
 * `institution.ts` does it: a development database is allowed to hold
 * applications born under placeholders, and a document is not.
 */

import { PLACEHOLDER_ORIGINATOR, type DuOriginator } from "@hm/du";
import { config } from "../config.js";
import type { Db } from "./db.js";

/**
 * The configured originator, field by field, with the placeholder standing
 * wherever the configuration says nothing. Never mixed silently: a real value
 * beside a placeholder is visible in `originatorPlaceholdersIn`.
 */
export function originatorFromConfig(): DuOriginator {
  const blank = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
  return {
    companyLegalName:
      blank(config.originator.companyLegalName) ?? PLACEHOLDER_ORIGINATOR.companyLegalName,
    companyNmlsId: blank(config.originator.companyNmlsId) ?? PLACEHOLDER_ORIGINATOR.companyNmlsId,
    originatorFirstName:
      blank(config.originator.originatorFirstName) ?? PLACEHOLDER_ORIGINATOR.originatorFirstName,
    originatorLastName:
      blank(config.originator.originatorLastName) ?? PLACEHOLDER_ORIGINATOR.originatorLastName,
    originatorNmlsId:
      blank(config.originator.originatorNmlsId) ?? PLACEHOLDER_ORIGINATOR.originatorNmlsId,
  };
}

/**
 * The two rows, once. Idempotent by role: an application already carrying a
 * company or an originator keeps the one it has, because a re-run of the
 * writer is not a change of originator.
 *
 * The shapes are the CHECKs' — `du_deal_parties_name_matches_the_role` wants
 * a legal entity name on the company and first/last on the person, and
 * `du_deal_parties_origination_roles_are_licensed` wants a license on both.
 * `Private` is the register: NMLS.
 */
export async function recordOriginationParties(
  tx: Db,
  applicationId: string,
  originator: DuOriginator = originatorFromConfig(),
): Promise<void> {
  const company = await tx.duDealParty.findFirst({
    where: { applicationId, role: "LoanOriginationCompany" },
    select: { id: true },
  });
  if (!company) {
    await tx.duDealParty.create({
      data: {
        applicationId,
        role: "LoanOriginationCompany",
        legalEntityName: originator.companyLegalName,
        licenseIdentifier: originator.companyNmlsId,
        licenseAuthorityType: "Private",
      },
    });
  }
  const person = await tx.duDealParty.findFirst({
    where: { applicationId, role: "LoanOriginator" },
    select: { id: true },
  });
  if (!person) {
    await tx.duDealParty.create({
      data: {
        applicationId,
        role: "LoanOriginator",
        firstName: originator.originatorFirstName,
        lastName: originator.originatorLastName,
        licenseIdentifier: originator.originatorNmlsId,
        licenseAuthorityType: "Private",
      },
    });
  }
}
