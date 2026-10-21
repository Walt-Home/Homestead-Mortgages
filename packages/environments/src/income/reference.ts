/**
 * The reference policy for qualifying-income: the rulebook followed
 * literally, through the tools. Reading a flag, a type or a date, and
 * comparing two figures, is reading; every sum, product, quotient and date
 * step is a tool call. The calls that wait on nothing else go together in
 * one turn, as a model may make them, so a file of six sources takes five
 * turns. Held to the grader on every generated task, it is the proof that
 * each application can be worked from the rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { INCOME_SUBMIT_TOOL } from "./tools.js";

interface Req {
  readonly name: string;
  readonly input: Json;
  readonly key: string;
}

/** Independent calls made together in one turn; read back in order. */
let batches = 0;
function* together(reqs: readonly Req[]): Step<string[]> {
  if (reqs.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = reqs.map((q, k) => ({
    id: `qi-${batch}-${k}`,
    name: q.name,
    input: q.input,
  }));
  const observations = yield calls;
  return calls.map((c, k) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return String((JSON.parse(o.content) as Record<string, unknown>)[reqs[k]!.key]);
  });
}

const calc = (expression: string): Req => ({
  name: "calculate",
  input: { expression },
  key: "value",
});
const months = (date: string, n: number): Req => ({
  name: "date_add",
  input: { date, months: n },
  key: "date",
});
const PERIODS: Readonly<Record<string, number>> = {
  annual: 1,
  monthly: 12,
  semimonthly: 24,
  biweekly: 26,
  weekly: 52,
};
const big = (x: unknown) => BigInt(String(x));

/** A source's row as it is worked out, phase by phase. */
interface Work {
  readonly s: Json;
  row: Json;
  /** The requests this source makes in the coming phase, and what to do with their answers. */
  next: { reqs: Req[]; then: (answers: string[]) => void } | null;
}

export function* incomeSteps(p: Json, _call: Call): Step<Json> {
  const application = p["application"] as Json;
  const note = String(application["scheduled_note_date"]);
  const sources = (p["borrowers"] as Json[]).flatMap((b) => b["sources"] as Json[]);

  const works: Work[] = sources.map((s) => ({
    s,
    row: {
      income_id: s["income_id"],
      method: null,
      trend: null,
      monthly_qualifying_cents: "0",
      nontaxable_cents: "0",
      gross_up_cents: "0",
      continuance_end_date: null,
      counted: false,
      exclusion_reason: null,
      liability_added_cents: "0",
    },
    next: null,
  }));

  /** Step 3 from the trend's two cross-products on: the history, then the figure. */
  const variable = (w: Work, hourly: boolean): Work["next"] => {
    const s = w.s;
    const ytd = String(s["ytd_cents"]);
    const m = String(s["ytd_months"]);
    const prior = String(s["prior_year_cents"]);
    return {
      reqs: [calc(`${ytd} * 12 - ${prior} * ${m}`), calc(`${ytd} * 1200 - ${prior} * ${m} * 95`)],
      then: ([up, band]) => {
        const trend = Number(up) > 0 ? "increasing" : Number(band) >= 0 ? "stable" : "decreasing";
        w.row["trend"] = trend;
        if (Number(s["history_months"]) < 12) {
          w.row["exclusion_reason"] = "history_under_12_months";
          w.next = null;
          return;
        }
        const st = s["stabilization"] as Json | null;
        if (trend !== "decreasing") {
          w.next = figure(w, `round((${ytd} + ${prior}) / (${m} + 12))`);
        } else if (!st) {
          w.row["exclusion_reason"] = "not_stabilized";
          w.next = null;
        } else if (hourly) {
          w.next = figure(w, `round(${ytd} / ${m})`);
        } else {
          w.next = figure(w, `round(${String(st["cents_since"])} / ${String(st["months_since"])})`);
        }
      },
    };
  };
  const figure = (w: Work, expression: string): Work["next"] => ({
    reqs: [calc(expression)],
    then: ([v]) => {
      w.row["monthly_qualifying_cents"] = v;
      w.next = null;
    },
  });

  // The first phase: what each source needs first, from Step 2 on.
  for (const w of works) {
    const s = w.s;
    switch (s["type"]) {
      case "base_salary":
        w.row["method"] = "base_salary";
        w.next = figure(
          w,
          `round(${String(s["pay_rate_cents"])} * ${PERIODS[String(s["pay_frequency"])]} / 12)`,
        );
        break;
      case "hourly": {
        const rate = String(s["rate_cents"]);
        const guaranteed = s["guaranteed_hours_per_week"];
        if (guaranteed != null && Number(guaranteed) > 0) {
          w.row["method"] = "base_hourly_fixed";
          w.next = figure(w, `round(${rate} * ${String(guaranteed)} * 52 / 12)`);
          break;
        }
        const max = String(s["hours_per_week_max"]);
        const min = String(s["hours_per_week_min"]);
        w.next = {
          reqs: [calc(`(${max} - ${min}) * 100 - 10 * ${max}`)],
          then: ([spread]) => {
            if (Number(spread) <= 0) {
              w.row["method"] = "base_hourly_fixed";
              w.next = figure(w, `round(${rate} * ${String(s["avg_hours_per_week"])} * 52 / 12)`);
            } else {
              w.row["method"] = "variable_base_trending";
              w.next = variable(w, true);
            }
          },
        };
        break;
      }
      case "overtime":
      case "commission":
      case "tip":
        w.row["method"] = "variable_trending";
        w.next = variable(w, false);
        break;
      case "social_security": {
        w.row["method"] = "social_security";
        const amount = String(s["monthly_benefit_cents"]);
        w.row["monthly_qualifying_cents"] = amount;
        const documented = s["documented_nontaxable_pct"];
        const share = documented != null && Number(documented) > 15 ? String(documented) : "15";
        if (s["record"] !== "own") w.row["continuance_end_date"] = s["benefit_end_date"];
        w.next = {
          reqs: [calc(`round(${amount} * ${share} / 100)`)],
          then: ([nontaxable]) => {
            w.row["nontaxable_cents"] = nontaxable;
            w.next = {
              reqs: [calc(`round(${nontaxable} * 25 / 100)`)],
              then: ([gross]) => {
                w.row["gross_up_cents"] = gross;
                w.next = null;
              },
            };
          },
        };
        break;
      }
      case "child_support":
      case "alimony":
      case "separate_maintenance": {
        w.row["method"] = "support";
        if (s["agreement_on_file"] !== true) {
          w.row["exclusion_reason"] = "no_agreement";
          break;
        }
        if (Number(s["receipts_months"]) < 6 || s["receipts_full_regular_timely"] !== true) {
          w.row["exclusion_reason"] = "receipt_history_insufficient";
          break;
        }
        const amount = String(s["monthly_cents"]);
        w.row["monthly_qualifying_cents"] = amount;
        if (s["type"] !== "child_support") {
          w.row["continuance_end_date"] = s["term_end_date"] ?? null;
          break;
        }
        w.row["nontaxable_cents"] = amount;
        w.next = {
          reqs: [
            calc(`round(${amount} * 25 / 100)`),
            months(String(s["child_date_of_birth"]), 216),
          ],
          then: ([gross, eighteenth]) => {
            w.row["gross_up_cents"] = gross;
            const extended = s["state_extends_support_to"] as string | null;
            w.row["continuance_end_date"] =
              extended && extended > eighteenth! ? extended : eighteenth;
            w.next = null;
          },
        };
        break;
      }
      case "retirement_distribution": {
        w.row["method"] = "retirement";
        const monthly = String(s["monthly_cents"]);
        if (s["unrestricted_penalty_free"] !== true) {
          w.row["exclusion_reason"] = "continuance_assets_insufficient";
          break;
        }
        const balances = (s["account_balances_cents"] as unknown[]).map(String);
        w.next = {
          reqs: [calc(`${balances.join(" + ") || "0"} - 36 * ${monthly}`)],
          then: ([cover]) => {
            if (big(cover) >= 0n) w.row["monthly_qualifying_cents"] = monthly;
            else w.row["exclusion_reason"] = "continuance_assets_insufficient";
            w.next = null;
          },
        };
        break;
      }
      case "public_assistance":
        w.row["method"] = "public_assistance";
        if (s["agency_letter_on_file"] !== true) {
          w.row["exclusion_reason"] = "agency_letter_missing";
          break;
        }
        w.row["monthly_qualifying_cents"] = String(s["monthly_cents"]);
        w.row["continuance_end_date"] = s["duration_end_date"] ?? null;
        break;
      case "rental_subject": {
        w.row["method"] = "rental_subject";
        const gross = String(s["form_1007_gross_rent_cents"]);
        const pitia = String(s["subject_pitia_cents"]);
        w.next = {
          reqs: [
            calc(`round(${gross} * 75 / 100) - ${pitia}`),
            calc(`${pitia} - round(${gross} * 75 / 100)`),
          ],
          then: ([anri, loss]) => {
            const experienced =
              Number(s["schedule_e_fair_rental_days"] ?? 0) >= 365 ||
              Number(s["management_experience_months"] ?? 0) >= 12;
            if (big(anri) < 0n) w.row["liability_added_cents"] = loss;
            else if (experienced) w.row["monthly_qualifying_cents"] = anri;
            else w.row["exclusion_reason"] = "offset_only";
            w.next = null;
          },
        };
        break;
      }
      default:
        throw new Error(`no rule for a source of type ${String(s["type"])}`);
    }
  }

  // Step 1 rides with the first phase; then each phase's calls go out together until none are left.
  let requiredThrough = "";
  let first = true;
  for (;;) {
    const pending = works.filter((w) => w.next !== null);
    const reqs = pending.flatMap((w) => w.next!.reqs);
    if (first) reqs.unshift(months(note, 36));
    if (reqs.length === 0) break;
    const answers = yield* together(reqs);
    if (first) requiredThrough = answers.shift()!;
    first = false;
    for (const w of pending) {
      const step = w.next!;
      step.then(answers.splice(0, step.reqs.length));
    }
  }

  // Steps 8 and 9.
  for (const w of works) {
    const r = w.row;
    const hasFigure = big(r["monthly_qualifying_cents"]) + big(r["gross_up_cents"]) > 0n;
    const end = r["continuance_end_date"] as string | null;
    if (hasFigure && end !== null && end < requiredThrough)
      r["exclusion_reason"] = "continuance_3y";
    r["counted"] = hasFigure && r["exclusion_reason"] === null;
  }

  // Step 10.
  const counted = works.filter((w) => w.row["counted"] === true);
  const terms = counted.flatMap((w) => [
    String(w.row["monthly_qualifying_cents"]),
    String(w.row["gross_up_cents"]),
  ]);
  const losses = works.map((w) => String(w.row["liability_added_cents"])).filter((x) => x !== "0");
  const [total, obligations] = yield* together([
    calc(terms.length ? terms.join(" + ") : "0"),
    calc(losses.length ? losses.join(" + ") : "0"),
  ]);

  return {
    sources: works.map((w) => w.row),
    total_qualifying_cents: total,
    obligations_from_rental_cents: obligations,
  };
}

export class IncomeReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:income-rulebook", incomeSteps, INCOME_SUBMIT_TOOL);
  }
}
