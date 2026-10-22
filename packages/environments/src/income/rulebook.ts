/**
 * The rules a model is given, and graded against.
 *
 * This is Fannie Mae's B3-3 qualifying income as the servicing app's
 * origination engine computes it (its spec §22.3, R2, R3, R5, R6, R11 and
 * R13): the calculators in ops-22-3.ts, in the order the service runs them
 * (calculate, the Reg B check, the continuance gate, the total), limited to
 * what v1's applications reach. Where the spec says two things, this says
 * what the engine does: Social Security's two roundings (R6's formula, not
 * the preamble's single rounding), the 10% band for "minor variances" in
 * hourly work (the engine's constant; the spec names no figure), and an end
 * on the very date three years out passing. The grader is the engine; the
 * reference policy follows these words through the tools and is held to it
 * on every generated task. Change this text and the environment's version
 * changes with it.
 */

export const INCOME_RULEBOOK = `# Qualifying income on a purchase application

You compute each income source's monthly qualifying figure the way the lender's income engine does (Fannie Mae Selling Guide B3-3), decide whether each source counts, and total the household's qualifying income. Follow these rules exactly and in order. Use the tools for every calculation and every date; never estimate.

Conventions:
- Money is integer cents. Dates are YYYY-MM-DD. "Round" means round half up to a whole cent, and only where a rule says round; everything before it is exact.
- Comparing two dates, or two amounts, is reading: it needs no tool. Working one out does.
- Every source on the file is worked, whichever borrower it belongs to. Each source ends with: method, trend, monthly_qualifying_cents (monthly below), nontaxable_cents, gross_up_cents, continuance_end_date, counted, exclusion_reason and liability_added_cents. Unless a step sets them, trend is null, nontaxable, gross-up and liability are 0, continuance_end_date is null and exclusion_reason is null.

## Regulation B

The formula is the same for every source of a type. Only the amount of income and its probable continuance (Steps 2 to 8) may change a figure. A borrower's age or retirement, part-time work, the regb_flags on a source, and the fact that income is Social Security, a retirement distribution, public assistance, alimony, separate maintenance or child support never lower a figure, never apply a factor below 1, and never exclude a source. An exclusion is only ever one of the reasons below: a history, documentation or continuance failure.

## Step 1. The continuance date

required_through = scheduled_note_date + 36 months (date_add with months: 36; a day the month lacks becomes its last day).

## Step 2. Base income

base_salary (method base_salary): annual = pay_rate_cents × the periods in a year (annual 1, monthly 12, semimonthly 24, biweekly 26, weekly 52); monthly = round(annual ÷ 12).

hourly: first classify the hours.
- guaranteed_hours_per_week above 0: fixed, and H is the guaranteed hours.
- Otherwise fixed when (hours_per_week_max − hours_per_week_min) × 100 ≤ 10 × hours_per_week_max (the high week; a spread of 10% of it, 10% exactly included, is a minor variance), and H is avg_hours_per_week. Otherwise the hours fluctuate: the source is variable.
- Fixed (method base_hourly_fixed): monthly = round(rate_cents × H × 52 ÷ 12). The year-to-date and history figures change nothing.
- Variable (method variable_base_trending): Step 3, with the hourly rule in 3.4.
overtime, commission, tip (method variable_trending): Step 3.

## Step 3. Variable income

3.1 The trend. ytd_monthly = ytd_cents ÷ ytd_months; prior_monthly = prior_year_cents ÷ 12. Compare them exactly (cross-multiply rather than round a quotient):
- increasing when ytd_monthly is above prior_monthly (ytd_cents × 12 > prior_year_cents × ytd_months);
- otherwise stable when ytd_monthly is at least 95% of prior_monthly, a decline of 5% exactly included (ytd_cents × 1200 ≥ prior_year_cents × ytd_months × 95);
- otherwise decreasing.
The trend is reported on every variable source, whatever happens next.
3.2 The history. history_months under 12: monthly is 0 and exclusion_reason is history_under_12_months. 12 months or more is enough (12 to 23 months comes with offsetting_factors, which are recorded and change nothing).
3.3 Stable or increasing: monthly = round((ytd_cents + prior_year_cents) ÷ (ytd_months + 12)).
3.4 Decreasing: with no stabilization record, monthly is 0 and exclusion_reason is not_stabilized. With one:
- overtime, commission or tip (B3-3.3-02): monthly = round(stabilization.cents_since ÷ stabilization.months_since);
- variable hourly (B3-3.3-01): monthly = round(ytd_cents ÷ ytd_months), the year-to-date over the months elapsed; the stabilization figures confirm it and are not used.

## Step 4. Social Security (method social_security)

monthly = monthly_benefit_cents. The nontaxable share is documented_nontaxable_pct when that is above 15, and otherwise 15. nontaxable = round(monthly × share ÷ 100); then gross_up = round(nontaxable × 25 ÷ 100). That is two roundings: the gross-up is 25% of the rounded nontaxable figure. On the borrower's own record (record "own") there is no end date; on another person's record or a dependent's, continuance_end_date is benefit_end_date.

## Step 5. Support (method support)

child_support, alimony and separate_maintenance:
- No agreement on file (agreement_on_file false): monthly 0, exclusion_reason no_agreement.
- Otherwise receipts_months under 6, or receipts not full, regular and timely: monthly 0, exclusion_reason receipt_history_insufficient.
- Otherwise monthly = monthly_cents.
  - child_support is wholly nontaxable: nontaxable = monthly, gross_up = round(monthly × 25 ÷ 100). continuance_end_date is the child's 18th birthday, child_date_of_birth + 216 months (date_add; a 29 February birth date gives 28 February), or state_extends_support_to when that is later.
  - alimony and separate_maintenance are taxable: no nontaxable share, no gross-up. continuance_end_date is term_end_date; an award with no term (null) has no defined end.

## Step 6. Retirement distributions (method retirement)

The balances prove continuance: when unrestricted_penalty_free is true and the account balances added together are at least 36 × monthly_cents, monthly = monthly_cents. Otherwise monthly is 0 and exclusion_reason is continuance_assets_insufficient. There is no end date.

## Step 7. Public assistance (method public_assistance)

No agency letter on file: monthly 0, exclusion_reason agency_letter_missing. Otherwise monthly = monthly_cents, and continuance_end_date is duration_end_date (null when the letter states no end).

## Step 7a. Rental income on the subject property (method rental_subject)

net = round(form_1007_gross_rent_cents × 75 ÷ 100); anri = net − subject_pitia_cents.
- anri below 0: the loss is an obligation, not income: liability_added = −anri and monthly is 0, with no exclusion reason.
- Otherwise, when the borrower has a year of property-management experience (schedule_e_fair_rental_days of 365 or more, or management_experience_months of 12 or more): monthly = anri.
- Otherwise the rent only offsets the payment: monthly is 0 and exclusion_reason is offset_only.

## Step 8. Continuance

A source has a figure when monthly + gross_up is above 0. Such a source with a continuance_end_date before required_through does not continue three years: it is not counted and its exclusion_reason is continuance_3y, but its monthly, nontaxable and gross_up stay as computed. An end on required_through itself passes. A source with no end date (null) passes.

## Step 9. Counted

counted is true when the source has a figure and passed Step 8, and false otherwise (an excluded source, a rental loss, rent that only offsets, a figure of 0).

## Step 10. The totals

total_qualifying_cents = the sum of monthly + gross_up over the counted sources, every borrower's together. obligations_from_rental_cents = the sum of liability_added over the sources.

## Submitting

Call submit_income once with sources (one entry per source: income_id, method, trend, monthly_qualifying_cents, nontaxable_cents, gross_up_cents, continuance_end_date, counted, exclusion_reason, liability_added_cents), total_qualifying_cents and obligations_from_rental_cents. Cents are strings of digits. A submission that does not fit the tool's schema comes back as an error to be corrected; a valid one ends the task.
`;
