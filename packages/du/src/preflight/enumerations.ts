/**
 * Which list of values is the right one at which destination.
 *
 * The generated enumeration table is keyed by the enum a column holds, because
 * that is what it exists to check the database against. Checking a casefile
 * needs the other direction — a value at an XPath, and the list it has to be
 * in — and the join between them is the data point, which the generator already
 * carries and this table mirrors. A test pins every row here against the
 * generator's own map, so the two cannot drift.
 *
 * **The destination is part of the key and not decoration.** `MortgageType`
 * appears on a liability, where Desktop Underwriter supports one value, and on
 * the terms of the loan being applied for, where it supports the products.
 * Keying on the data point alone would refuse every conventional casefile in
 * Fannie Mae's own corpus.
 *
 * **Two data points are deliberately unchecked, at three destinations between
 * them**, for the same reason a fourth would be a bug:
 *
 * - `ROLE_DETAIL/PartyRoleType`, at both destinations the casefile carries it.
 *   Its enum is the non-borrower subset — the borrower has a container of its
 *   own and a vesting carries a name rather than a person — so checking a role
 *   against it would refuse every borrower. The message-level one is worse
 *   still: the only value it ever holds is `SubmittingParty`, which the
 *   generator excludes from that enum by construction, so the check would
 *   refuse the one casefile shape it could see.
 * - `ORIGINATION_FUND/FundsSourceType`. The specification's enumeration tab
 *   carries a `PropertySeller` value on rows whose form field is blank, and the
 *   rows the generated list is derived from are not those, so the list is
 *   twelve values where this destination can lawfully carry thirteen.
 *
 * `TERMS_OF_LOAN/MortgageType` was a third until `loan_products` gave the loan
 * being applied for a mortgage type of its own. There was nothing to check it
 * against: the only enum joined to that data point was the liability's, whose
 * single supported value is `FHA`, and ten of the eighteen shipped samples are
 * conventional. It is checked now, against `DuMortgageType`, which is the whole
 * argument for the destination being part of the key.
 *
 * `AMORTIZATION_RULE/AmortizationType` arrived with the same row. While the
 * word lived on the file it was `'fixed'` or `'arm'` and the emitter translated
 * it, so what reached this gate was whatever that lookup produced; the column
 * holds the DU value now, and this is what says the column cannot hold one DU
 * does not support.
 */

/** The destination, as `XPath#DataPointName`, and the enum its value must be in. */
export const DU_SUBSET_AT: Readonly<Record<string, string>> = {
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/ASSET_DETAIL#AssetType": "DuAssetType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/ASSET_DETAIL#AssetTypeOtherDescription":
    "DuAssetTypeOtherDescription",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/ASSET_DETAIL#FundsSourceType":
    "DuFundsSourceType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/OWNED_PROPERTY_DETAIL#OwnedPropertyDispositionStatusType":
    "DuOwnedPropertyDisposition",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL#PropertyCurrentUsageType":
    "DuPropertyUsage",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL#PropertyUsageType":
    "DuIntendedPropertyUsage",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL#PropertyUsageTypeOtherDescription":
    "DuPropertyUsageOtherDescription",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/PROPERTY_DETAIL#AttachmentType":
    "DuAttachmentType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/PROPERTY_DETAIL#PropertyEstateType":
    "DuPropertyEstateType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/PROPERTY_DETAIL#PropertyUsageType":
    "DuIntendedPropertyUsage",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/EXPENSES/EXPENSE#ExpenseType": "DuExpenseType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LIABILITIES/LIABILITY/LIABILITY_DETAIL#LiabilityType":
    "DuLiabilityType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LIABILITIES/LIABILITY/LIABILITY_DETAIL#MortgageType":
    "DuLiabilityMortgageType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/AMORTIZATION/AMORTIZATION_RULE#AmortizationType":
    "DuAmortizationType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/TERMS_OF_LOAN#MortgageType": "DuMortgageType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/EXTENSION/OTHER/DU:LOAN_EXTENSION/DU:UNDERWRITING_VERIFICATIONS/DU:UNDERWRITING_VERIFICATION#DU:VerificationReportType":
    "DuVerificationReportType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/BANKRUPTCIES/BANKRUPTCY/BANKRUPTCY_DETAIL#BankruptcyChapterType":
    "DuBankruptcyChapter",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/DECLARATION/DECLARATION_DETAIL#HomeownerPastThreeYearsType":
    "DuYesNo",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/DECLARATION/DECLARATION_DETAIL#IntentToOccupyType":
    "DuYesNo",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/DECLARATION/DECLARATION_DETAIL#PriorPropertyTitleType":
    "DuPriorPropertyTitle",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/DECLARATION/DECLARATION_DETAIL#PriorPropertyUsageType":
    "DuPropertyUsage",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL#BorrowerResidencyBasisType":
    "DuResidencyBasis",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL#BorrowerResidencyType":
    "DuResidencyType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/LICENSES/LICENSE/LICENSE_DETAIL#LicenseAuthorityLevelType":
    "DuLicenseAuthorityLevel",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/PROPERTY_OWNER#PropertyOwnerStatusType":
    "DuPropertyOwnerStatus",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/PROPERTY_OWNER#RelationshipVestingType":
    "DuVestingType",
};

/**
 * The destinations left out on purpose, with the reason in the header above.
 *
 * Declared rather than silent, so that "nobody got to it" and "checking it here
 * would be wrong" are different states — which is the same reason the generator
 * declares an enum that is ours as local rather than leaving it unmapped.
 */
export const NOT_CHECKED_AGAINST_A_SUBSET: readonly string[] = [
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/ROLE_DETAIL#PartyRoleType",
  "MESSAGE/DEAL_SETS/PARTIES/PARTY/ROLES/ROLE/ROLE_DETAIL#PartyRoleType",
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/ORIGINATION_FUNDS/ORIGINATION_FUND#FundsSourceType",
];
