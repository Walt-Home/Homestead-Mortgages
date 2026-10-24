/**
 * The pre-dial checks an outbound call had to pass, read from the facts the
 * dialer held when it dialed.
 *
 * The 11.1 guardrail is "no dial without every pre-dial check passing", and
 * the servicing app computes the checks from `pre_dial_facts` in
 * `preDialChecks` (apps/servicing/src/app/tools/section11.ts:84-105) through
 * its evaluators (src/app/evaluators.ts:256-259, :279). The facts here are
 * that function's, named as it names them, less the three gates v1 does not
 * grade (the post-conversation cooling-off, the pre-sale stop and the
 * workplace rule; docs/environments.md, "call-qa"). Each check restates the
 * servicing app's own lines, cited, and a test holds each line to them:
 *
 *   consent      an AI-voice call (an artificial voice: FCC 24-17) to a number
 *                that is not a landline needs unrevoked TCPA voice consent
 *                (section11.ts:94-96; evaluators.ts:258);
 *   line type    an AI-voice call to a landline without written consent is the
 *                third in 30 days at most (section11.ts:95; evaluators.ts:259);
 *   time zone    after 08:00 and at or before 20:30 for a voice call, local
 *                time in every candidate zone (section11.ts:91-92;
 *                evaluators.ts:257; 11.1 rule 8 and 11.1-T12);
 *   Reg F count  on a debt collector's loan the seventh counted call in seven
 *                days at most (§1006.14(b); evaluators.ts:256), elsewhere the
 *                state's or the policy's cap: 2 in Massachusetts
 *                (940 CMR 7.04), otherwise 5 (section11.ts:99-100;
 *                domain/early-intervention/ops.ts:497-500);
 *   cease, bankruptcy, attorney
 *                no dial while a cease, an open bankruptcy or a represented
 *                consumer is flagged (section11.ts:104, :337).
 *
 * The servicing app separates the consent check from the line-type check
 * only by its branch; v1 reports them as the two findings the 11.1 decision
 * record names (`consent_id`, `line_type`, `landline_ai_30d`).
 */

import { wallClock } from "@hm/kernel/calendar";

export interface PreDialFacts {
  /** The instant the call was dialed, ISO 8601 in UTC. */
  readonly dial_at: string;
  readonly mode: "human_voice" | "ai_voice";
  /** The candidate time zones of the consumer's location: the property's, then the number's area code's. */
  readonly time_zones: readonly string[];
  readonly line_type: "mobile" | "landline";
  readonly tcpa_voice_consent_active: boolean;
  readonly written_consent: boolean;
  /** AI-voice calls to this number before this one, ISO instants. */
  readonly ai_voice_attempts_at: readonly string[];
  readonly fdcpa_debt_collector: boolean;
  /** The property's state. */
  readonly state: string;
  /** Counted calls (outbound voice calls that connected) to this person about this loan before this one, ISO instants. */
  readonly counted_call_attempts_at: readonly string[];
  /** Voicemails left on this number in the seven days before the call. */
  readonly voicemails_to_number_7d: number;
  /** An oral request to stop calling, honored as a cease (11.1 edge cases, "Oral stop calling"). */
  readonly cease_active: boolean;
  /** A written FDCPA §805(c) cease (Reg F §1006.6(c)). */
  readonly written_cease: boolean;
  readonly bk_active: boolean;
  readonly attorney_represented: boolean;
}

export const VOICE_WINDOW = { after: "08:00", through: "20:30" } as const;
export const DAY_MS = 86_400_000;
/** Reg F §1006.14(b)'s 7 calls in 7 days; Massachusetts' 2 (940 CMR 7.04); the policy's 5 (11.1-Q5). */
export const CALL_CAP = { debt_collector: 7, MA: 2, policy: 5 } as const;
export const CALL_CAP_DAYS = 7;
/** 47 CFR 64.1200(a)(3): an artificial-voice call to a residential landline, three in 30 days without written consent. */
export const LANDLINE_AI_CAP = 3;
export const LANDLINE_AI_DAYS = 30;

/** The trailing-window counter the servicing app's evaluators use (evaluator-kit.ts `within`). */
export const within = (times: readonly string[], days: number, now: string): number =>
  times.filter(
    (t) => Date.parse(now) - Date.parse(t) < days * DAY_MS && Date.parse(t) <= Date.parse(now),
  ).length;

/** The wall-clock time of an instant in a zone, "HH:MM", as section11.ts:91 writes it. */
export function localTime(instant: string, timeZone: string): { date: string; time: string } {
  const w = wallClock(Date.parse(instant), timeZone);
  return {
    date: w.date,
    time: `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`,
  };
}

export const inVoiceWindow = (hhmm: string): boolean =>
  /^\d\d:\d\d$/.test(hhmm) && hhmm > VOICE_WINDOW.after && hhmm <= VOICE_WINDOW.through;

export type PreDialCheck =
  "consent" | "line_type" | "time_zone" | "regf_count" | "cease" | "bankruptcy" | "attorney";

/** Each check the facts fail, in this order, with why. */
export function failedPreDialChecks(
  f: PreDialFacts,
): { readonly check: PreDialCheck; readonly why: string }[] {
  const out: { check: PreDialCheck; why: string }[] = [];
  if (f.mode === "ai_voice") {
    if (f.line_type === "landline") {
      const n = within(f.ai_voice_attempts_at, LANDLINE_AI_DAYS, f.dial_at);
      if (!f.written_consent && n + 1 > LANDLINE_AI_CAP)
        out.push({
          check: "line_type",
          why: `an AI-voice call to a landline, the ${n + 1}th in ${LANDLINE_AI_DAYS} days without written consent`,
        });
    } else if (!f.tcpa_voice_consent_active)
      out.push({
        check: "consent",
        why: `an AI-voice call to a ${f.line_type} number with no TCPA voice consent`,
      });
  }
  const local = f.time_zones.map((tz) => ({ tz, ...localTime(f.dial_at, tz) }));
  const bad = local.filter((l) => !inVoiceWindow(l.time));
  if (local.length === 0 || bad.length > 0)
    out.push({
      check: "time_zone",
      why: `outside the voice window in ${bad.map((l) => `${l.tz} (${l.time})`).join(", ") || "every zone"}`,
    });
  const n = within(f.counted_call_attempts_at, CALL_CAP_DAYS, f.dial_at);
  const cap = f.fdcpa_debt_collector
    ? CALL_CAP.debt_collector
    : f.state === "MA"
      ? CALL_CAP.MA
      : CALL_CAP.policy;
  if (n + 1 > cap)
    out.push({
      check: "regf_count",
      why: `${n + 1} counted calls in ${CALL_CAP_DAYS} days, over ${cap}`,
    });
  if (f.cease_active || f.written_cease)
    out.push({
      check: "cease",
      why: f.written_cease ? "a written cease" : "a request to stop calling",
    });
  if (f.bk_active) out.push({ check: "bankruptcy", why: "an open bankruptcy case" });
  if (f.attorney_represented)
    out.push({ check: "attorney", why: "the borrower is represented by counsel" });
  return out;
}
