/**
 * How two pulls decide they are talking about the same employer, and the same
 * income.
 *
 * Nothing here touches the database, because the interesting part is not the
 * lookup — it is the guess. No vendor we ship against gives a stable identifier
 * for an employer or for an income stream. The connector port carries exactly
 * one vendor id and it is per REPORT (`ConnectorResult.externalId`); the domain
 * `IncomeSource` carries none at all; Plaid's employer identity is a name
 * string, and in Assets mode that string is a transaction memo — uppercased,
 * stripped of non-letters, shorn of ACH/DEBIT/PMT/WEB and cut to three words.
 *
 * So identity is derived, and a derived key is a guess about sameness. These
 * are the guesses, stated here rather than discovered in production:
 *
 * 1. Two different employers whose names normalize identically, under one
 *    party, become one employer row. Unavoidable with a name key.
 * 2. In Assets mode the name key is a fingerprint of the institution's
 *    descriptor formatting, so one employer SPLITS into two rows when the
 *    institution changes that formatting, and two payers whose memos truncate
 *    alike MERGE. `employers.derived_from` is what makes such a row
 *    identifiable afterwards.
 * 3. Two same-type income streams from one employer are told apart only by
 *    their position within the report, and vendor ordering is not guaranteed
 *    stable. If two such rows swap identities between pulls every sum is
 *    unchanged, but the per-row continuance judgment follows the wrong twin.
 * 4. An EIN is matched exactly and a name is what everything else is matched
 *    on, in both directions across a promotion — so an employer reported under
 *    two spellings that do NOT normalize alike is two rows, whichever of them
 *    carries the EIN and whichever pull runs first. Two EINs reported under one
 *    trade name are two rows as well, which is right; the cost is that a later
 *    report with no EIN at all can only join the older of them.
 */

/** The `name:` key a record with no usable EIN gets, and the one an EIN-bearing
 * record would have had — which is what a promotion looks itself up by. */
export function employerNameKey(employerName: string): string {
  return `name:${employerName.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/** Only the digits, so `00-0000001` and `000000001` are one employer. */
export function einDigits(ein: string | null | undefined): string {
  return (ein ?? "").replace(/\D/g, "");
}

/**
 * An EIN wins where there is one and a normalized name stands in where there is
 * not.
 *
 * The asymmetry is real and it is why promotion exists: only the payroll path
 * carries an EIN, so the same job arrives keyed by name from the bank and by
 * EIN from payroll.
 */
export function employerIdentityKey(record: {
  readonly employerName: string;
  readonly employerEin?: string | null;
}): { readonly key: string; readonly derivedFrom: "ein" | "name" } {
  const digits = einDigits(record.employerEin);
  return digits
    ? { key: `ein:${digits}`, derivedFrom: "ein" }
    : { key: employerNameKey(record.employerName), derivedFrom: "name" };
}

/**
 * The income types a report's employer can be the source of.
 *
 * Anything outside this set — retirement, rental, social security — is income
 * a job does not pay, so attaching it to the employer the report happens to
 * name would be an invention.
 */
const EMPLOYER_PAID: ReadonlySet<string> = new Set([
  "base_wage",
  "overtime",
  "bonus",
  "commission",
  "equity_compensation",
  "military_entitlement",
]);

/**
 * Which employer a reported income source belongs to, given that no vendor
 * says.
 *
 * The port hands us two flat arrays with no link between them, so the only
 * honest answer is the unambiguous one: wage-shaped income attaches to the
 * report's employer when the report names exactly one active employer, and to
 * nothing when it names several and cannot say which. Unattached is not a
 * failure — it keys the row as `self:` and matching still works; it just
 * cannot follow the job when the employer's own identity improves.
 */
export function employerForIncome(
  type: string,
  activeEmployerIds: readonly string[],
): string | null {
  if (!EMPLOYER_PAID.has(type)) return null;
  return activeEmployerIds.length === 1 ? activeEmployerIds[0]! : null;
}

/**
 * How two pulls decide they are talking about the same income.
 *
 * `ordinal` is this row's position among rows in the SAME report that produce
 * the same key. It is the only discriminator available for two same-type
 * streams from one employer; see guess 3 above for what it costs.
 */
export function incomeIdentityKey(args: {
  readonly type: string;
  readonly employerId: string | null;
  readonly ordinal: number;
}): string {
  const base = args.employerId ? `emp:${args.employerId}|${args.type}` : `self:${args.type}`;
  return args.ordinal > 1 ? `${base}#${args.ordinal}` : base;
}
