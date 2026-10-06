/**
 * When the scheduled jobs run, as a page says it.
 *
 * The schedules themselves are Terraform's — `infra/variables.tf`, one cron
 * expression per job in America/New_York — and these are copies, held equal
 * by `schedules.test.ts`, which reads that file. A page that said "7 AM"
 * after the job moved to eight would be believed, so the copy cannot be
 * allowed to drift; and the words are made from the expression rather than
 * written beside it, so a change to one is a change to both.
 */

export interface Schedule {
  /** Five-field cron: minute, hour, day of month, month, day of week. */
  readonly cron: string;
  readonly timeZone: "America/New_York";
}

/** The daily refinance review over every watched loan (`services/loan-review.ts`). */
export const LOAN_REVIEW_SCHEDULE: Schedule = { cron: "0 7 * * *", timeZone: "America/New_York" };

/** The month-close that writes each servicer's statement (`services/billing.ts`). */
export const BILLING_CLOSE_SCHEDULE: Schedule = {
  cron: "0 6 1 * *",
  timeZone: "America/New_York",
};

const ZONE_WORDS: Record<Schedule["timeZone"], string> = { "America/New_York": "Eastern" };

function clockWords(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function ordinal(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/**
 * The schedule in words: "every morning at 7:00 AM Eastern", "the 1st of
 * each month at 6:00 AM Eastern". Refuses a shape it has no words for, so
 * a schedule nobody taught it cannot be described wrongly.
 */
export function scheduleWords(s: Schedule): string {
  const fields = s.cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`not a five-field cron: ${s.cron}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || month !== "*" || dayOfWeek !== "*") {
    throw new Error(`no words for this schedule: ${s.cron}`);
  }
  const at = `${clockWords(Number(hour), Number(minute))} ${ZONE_WORDS[s.timeZone]}`;
  if (dayOfMonth === "*") return `every ${Number(hour) < 12 ? "morning" : "day"} at ${at}`;
  if (/^\d{1,2}$/.test(dayOfMonth))
    return `the ${ordinal(Number(dayOfMonth))} of each month at ${at}`;
  throw new Error(`no words for this schedule: ${s.cron}`);
}

export interface ScheduleWire extends Schedule {
  readonly words: string;
}

export interface CadenceWire {
  readonly review: ScheduleWire;
  readonly billingClose: ScheduleWire;
}

/** The two cadences a billing page states: when loans are analyzed, and when a month is closed. */
export function cadenceWire(): CadenceWire {
  return {
    review: { ...LOAN_REVIEW_SCHEDULE, words: scheduleWords(LOAN_REVIEW_SCHEDULE) },
    billingClose: { ...BILLING_CLOSE_SCHEDULE, words: scheduleWords(BILLING_CLOSE_SCHEDULE) },
  };
}
