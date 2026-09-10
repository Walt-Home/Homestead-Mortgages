/**
 * How a number is said, once, for every screen that says it.
 *
 * Three screens each defined the same money formatter locally, and two of them
 * then named the same engine figure two different things: the bank screen
 * called `ratios.totalQualifyingIncome` "Monthly income" and the review screen
 * called it "Verified income". One borrower's own two screens disagreed about
 * what to call the number their decision turns on. A formatter and a label
 * copied per screen are a formatter and a label that drift per screen.
 */

/** Whole dollars. No screen in this product has a use for the cents. */
export const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/**
 * `ratios.totalQualifyingIncome`, said one way.
 *
 * "Verified" over "Monthly", because the distinction a borrower needs is
 * between this figure and the one they typed on screen 1. The engine counts
 * only income sources a retrieval established a continuance for — the stated
 * figure never reaches it — so "verified" is the true thing about it, and the
 * period the other label carried is still said, in the value.
 */
export const QUALIFYING_INCOME_LABEL = "Verified income";

export const qualifyingIncome = (n: number) => `${money(n)}/mo`;
