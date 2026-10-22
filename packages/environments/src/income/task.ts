/**
 * A qualifying-income task: one purchase application on its scheduled note
 * date, its borrowers, and the income each declared, with the figures each
 * source's documents show (the servicing app's origination engine, spec
 * §22.3: Fannie Mae B3-3).
 *
 * The model gets what the underwriter has: the paystub's year-to-date and
 * the W-2's prior year, the hours and the rate, the Social Security award
 * letter, the decree and the receipts, the account statements, the agency
 * letter, the Form 1007 and the Schedule E. It must classify each source,
 * compute its monthly qualifying figure, decide continuance and what is
 * excluded and why, and total the household. What the engine concludes is
 * computed by the grader and never rendered.
 *
 * Every borrower also carries facts Regulation B protects (age, retirement,
 * part-time work, the intake's flags). They are on the file because an
 * application has them; none of them may change a figure.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const INCOME_ENVIRONMENT_NAME = "qualifying-income";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const INCOME_ENVIRONMENT_VERSION = "1.0.0";

/** The intake's Regulation B tags (the engine's RegBFlag less "leave", which v1 never carries). */
export type RegBFlag =
  "part_time" | "retirement" | "public_assistance" | "alimony_child_support" | "age_related";

export type PayFrequency = "annual" | "monthly" | "semimonthly" | "biweekly" | "weekly";
export const PERIODS_PER_YEAR: Readonly<Record<PayFrequency, number>> = {
  annual: 1,
  monthly: 12,
  semimonthly: 24,
  biweekly: 26,
  weekly: 52,
};

interface SourceBase {
  readonly income_id: string;
  readonly regb_flags: readonly RegBFlag[];
}

/** Year-to-date from the most recent paystub, the prior year from the W-2s, and the history of receipt. */
export interface EarningsHistory {
  /** The day the year-to-date figure runs through: a month's end or its 15th. */
  readonly ytd_through: PlainDate;
  readonly ytd_cents: Cents;
  /** Months the year-to-date figure covers: whole, or a half for a period ending on the 15th. */
  readonly ytd_months: number;
  readonly prior_year_cents: Cents;
  /** Months this income has been received, to the paystub's date. */
  readonly history_months: number;
  /** Positive factors offsetting a history under 24 months; given whenever the history is 12 to 23 months. */
  readonly offsetting_factors: readonly string[];
  /** The paystub series showing a flat run after a decline, or null when there is none. */
  readonly stabilization: {
    readonly since: PlainDate;
    readonly cents_since: Cents;
    readonly months_since: number;
  } | null;
}

export interface BaseSalarySource extends SourceBase {
  readonly type: "base_salary";
  readonly pay_rate_cents: Cents;
  readonly pay_frequency: PayFrequency;
  readonly part_time: boolean;
}

export interface HourlySource extends SourceBase, EarningsHistory {
  readonly type: "hourly";
  readonly rate_cents: Cents;
  /** Guaranteed weekly hours, or null; when it is set no range is given. */
  readonly guaranteed_hours_per_week: number | null;
  readonly hours_per_week_min: number | null;
  readonly hours_per_week_max: number | null;
  /** The average weekly hours over the paystubs; always given with a range. */
  readonly avg_hours_per_week: number | null;
  readonly part_time: boolean;
}

export interface VariableSource extends SourceBase, EarningsHistory {
  readonly type: "overtime" | "commission" | "tip";
}

export interface SocialSecuritySource extends SourceBase {
  readonly type: "social_security";
  readonly benefit: "retirement" | "disability" | "survivor";
  readonly record: "own" | "another_person" | "dependent";
  readonly monthly_benefit_cents: Cents;
  /** The nontaxable share the tax return documents, in percent, or null when none is documented. */
  readonly documented_nontaxable_pct: number | null;
  /** When the benefit ends, from the award letter; always given on another's record, never on the borrower's own. */
  readonly benefit_end_date: PlainDate | null;
}

interface SupportFacts {
  readonly monthly_cents: Cents;
  /** A divorce decree, separation agreement or court order on file. */
  readonly agreement_on_file: boolean;
  /** Months of documented receipt. */
  readonly receipts_months: number;
  readonly receipts_full_regular_timely: boolean;
}

export interface ChildSupportSource extends SourceBase, SupportFacts {
  readonly type: "child_support";
  readonly child_date_of_birth: PlainDate;
  /** The date state law extends support to, or null. */
  readonly state_extends_support_to: PlainDate | null;
}

export interface SpousalSupportSource extends SourceBase, SupportFacts {
  readonly type: "alimony" | "separate_maintenance";
  /** The date the award ends, or null for an award with no term. */
  readonly term_end_date: PlainDate | null;
}

export interface RetirementSource extends SourceBase {
  readonly type: "retirement_distribution";
  readonly monthly_cents: Cents;
  /** Each eligible retirement account's balance. */
  readonly account_balances_cents: readonly Cents[];
  readonly unrestricted_penalty_free: boolean;
}

export interface PublicAssistanceSource extends SourceBase {
  readonly type: "public_assistance";
  readonly monthly_cents: Cents;
  readonly agency_letter_on_file: boolean;
  /** The end of the benefit's stated duration, or null when the letter states none. */
  readonly duration_end_date: PlainDate | null;
}

export interface SubjectRentalSource extends SourceBase {
  readonly type: "rental_subject";
  /** Monthly market rent from the Form 1007 rent schedule. */
  readonly form_1007_gross_rent_cents: Cents;
  readonly subject_pitia_cents: Cents;
  /** Fair Rental Days on the borrower's latest Schedule E, or null. */
  readonly schedule_e_fair_rental_days: number | null;
  /** Documented months of property-management experience, or null. */
  readonly management_experience_months: number | null;
}

export type IncomeSource =
  | BaseSalarySource
  | HourlySource
  | VariableSource
  | SocialSecuritySource
  | ChildSupportSource
  | SpousalSupportSource
  | RetirementSource
  | PublicAssistanceSource
  | SubjectRentalSource;
export type SourceType = IncomeSource["type"];

export interface Borrower {
  readonly borrower_id: string;
  /** Age on the application date. */
  readonly age: number;
  readonly retired: boolean;
  readonly sources: readonly IncomeSource[];
}

export interface IncomeTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly application: {
    readonly application_date: PlainDate;
    readonly scheduled_note_date: PlainDate;
    /** Purchase only in v1. */
    readonly transaction: "purchase";
    readonly occupancy: "principal_residence" | "second_home" | "investment";
  };
  readonly borrowers: readonly Borrower[];
}

export const sourcesOf = (task: IncomeTask): IncomeSource[] =>
  task.borrowers.flatMap((b) => b.sources);

export function incomePayload(task: IncomeTask): Record<string, unknown> {
  return plain({ application: task.application, borrowers: task.borrowers }) as Record<
    string,
    unknown
  >;
}

export function renderIncomeTask(task: IncomeTask): string {
  const n = sourcesOf(task).length;
  return [
    `Compute the qualifying income on this purchase application, scheduled to close on ${task.application.scheduled_note_date}: ${task.borrowers.length === 1 ? "one borrower" : `${task.borrowers.length} borrowers`}, ${n} income ${n === 1 ? "source" : "sources"}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(incomePayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_income.",
  ].join("\n");
}
