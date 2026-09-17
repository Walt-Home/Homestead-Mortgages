/**
 * How title will read, in the borrower's words.
 *
 * URLA L2.1 asks for the name that will be on title once the loan closes,
 * L2.4 for how it will be held, and L2.2 — refinance only — for the name that
 * is on it today. The default sentence is the corpus's shape: every
 * borrower's name, joined. The manner of holding is required whenever more
 * than one name is on title and offered otherwise, because the register's
 * three vesting-less owners are all single names.
 */

import type { VestingType } from "@hm/shared";

export const PROPOSED_VESTING = "How will the title read?";
export const CURRENT_VESTING = "How is the title held today?";
export const VESTING_TYPE = "How will it be held?";

export const VESTING_TYPE_LABELS: Record<VestingType, string> = {
  Individual: "One owner",
  JointTenantsWithRightOfSurvivorship: "Joint tenants with right of survivorship",
  TenantsByTheEntirety: "Tenants by the entirety",
  TenantsInCommon: "Tenants in common",
  LifeEstate: "Life estate",
  Other: "Another way",
};

export interface VestingForm {
  proposedName: string;
  /** "" until chosen; the route takes null for "no relationship to state". */
  vestingType: VestingType | "";
  /** Refinance only. */
  currentName: string;
}

/** The corpus's shape: "Andy America and Amy America". */
export function defaultVestingSentence(
  borrowers: readonly { firstName: string; lastName: string }[],
): string {
  return borrowers.map((b) => `${b.firstName} ${b.lastName}`).join(" and ");
}

export function vestingAnswered(
  form: VestingForm,
  borrowerCount: number,
  refinance: boolean,
): boolean {
  if (form.proposedName.trim() === "") return false;
  if (borrowerCount > 1 && form.vestingType === "") return false;
  if (refinance && form.currentName.trim() === "") return false;
  return true;
}

/** The POST body, with an empty manner sent as null and no current title on a purchase. */
export function vestingBody(form: VestingForm, refinance: boolean) {
  return {
    proposed: {
      fullName: form.proposedName.trim(),
      vestingType: form.vestingType === "" ? null : form.vestingType,
    },
    ...(refinance
      ? { current: { fullName: form.currentName.trim(), vestingType: null } }
      : { current: null }),
  };
}
