/**
 * How a column becomes the text of a data point.
 *
 * Every amount in this model is a `BigInt` of cents, and every amount on the
 * wire is a decimal with exactly two places — `12500.00`, never `12500` and
 * never `12500.0`. Going through a JavaScript number to get there is how a
 * balance of 210,027.00 becomes 210,026.99: the cents are exact and the double
 * is not, so the rendering below never leaves the integer domain.
 *
 * Signs are handled rather than assumed. `OwnedPropertyRentalIncomeNetAmount`
 * is income minus expenses and is negative when the property loses money:
 * `DI-C08` emits `-678.00`, and a renderer that padded the fractional part from
 * the absolute value would write `-678.-0`.
 */

/** Cents to the two-place decimal DU reads. */
export function renderAmount(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Basis points to the three-place percent the corpus carries.
 *
 * All eighteen samples write `NoteRatePercent` with three decimals — `5.000`,
 * `6.875` — and the same integer-only argument applies: 6875 basis points
 * through a double is not reliably 6.875.
 */
export function renderPercent(basisPoints: number): string {
  if (!Number.isInteger(basisPoints)) {
    throw new Error(`${basisPoints} is not a whole number of basis points.`);
  }
  const negative = basisPoints < 0;
  const magnitude = Math.abs(basisPoints);
  const whole = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;
  return `${negative ? "-" : ""}${whole}.${String(fraction).padStart(2, "0")}0`;
}

/** A count, a term in months, a number of units. */
export function renderCount(value: number): string {
  if (!Number.isInteger(value)) throw new Error(`${value} is not a whole number.`);
  return String(value);
}

/** MISMO writes indicators as the words, not as 1 and 0. */
export function renderIndicator(value: boolean): string {
  return value ? "true" : "false";
}

/**
 * A date, as `YYYY-MM-DD` in UTC.
 *
 * UTC rather than the server's zone, because a birth date read back in
 * `America/Los_Angeles` from a midnight-UTC column is the day before, and a
 * submission whose borrower is a day younger than their driver's license is a
 * mismatch somebody has to chase.
 */
export function renderDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * A datetime, as the corpus writes it: whole seconds, `Z`, no milliseconds.
 *
 * `2025-07-31T11:11:17Z`, from `DI-C04`. The three digits `toISOString` adds
 * are legal `xs:dateTime` and nothing in the eighteen carries them.
 */
export function renderDateTime(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}
