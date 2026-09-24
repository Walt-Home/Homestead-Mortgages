/**
 * The refinance analyst's turn — Doug's §33.2 rule 4, ported.
 *
 * Each morning the engine reviews every monitored loan and decides the
 * verdict. The analyst never decides: it reads the engine's facts as
 * `{{facts.<key>}}` tokens and writes one to three sentences in the
 * homeowner's language saying why, with flags from a closed list. Every
 * figure in the rationale is a token; the page fills it. A digit, an amount
 * or a spelled-out number of the model's own is a provenance violation: one
 * regeneration with the violation named, and a second violation skips the
 * turn, so the engine's own explanation stands. A token the day's facts do
 * not stand behind is refused the same way — that guard is ours, added
 * because a token the page cannot fill would reach the borrower as braces.
 *
 * Two tools, at most two calls: `review_facts` (the tokens and the words,
 * never a raw figure — asserted on every text field, so a violation there is
 * a bug and not the model's) and `review_write` (`{rationale, flags[]}` and
 * nothing else — a verdict key, a figure key or a bare number is refused as
 * ANALYST_NEVER_DECIDES). The prompt is his, verbatim, under his version.
 *
 * Nothing here touches the database. `analystTurn` never throws: the model
 * being off (no ANTHROPIC_API_KEY), the day's cap, a 429 or an outage, a
 * refusal and anything else are skip reasons the review row records beside
 * the verdict. The review runs the same with or without the model.
 */

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  reasonsInWords,
  reviewTokens,
  unknownTokens,
  VERDICT_WORDS,
  type ReviewFacts,
  type ReviewVerdict,
} from "@hm/refi-review";

type P = Record<string, unknown>;

export const ANALYST_PROMPT_VERSION = "33.2-p1";
export const DEFAULT_ANALYST_MODEL = "claude-opus-5";
/** The pass's cap: REFI_ANALYST_MAX_PER_DAY, default 500. */
export const DEFAULT_ANALYST_MAX_PER_DAY = 500;
/** At most two tool calls — review_facts, then review_write. */
export const ANALYST_MAX_TOOL_CALLS = 2;
export const ANALYST_MAX_TOKENS = 700;

export const ANALYST_FLAGS = [
  "value_stale",
  "value_low_confidence",
  "arm_reset_within_12m",
  "prepayment_penalty",
  "recent_modification",
  "pay_string_late",
  "bankruptcy_or_foreclosure",
  "high_ltv",
  "tape_exception",
] as const;
export type AnalystFlag = (typeof ANALYST_FLAGS)[number];

export interface AnalystReviewInput {
  readonly loan_id: string;
  readonly as_of_date: string;
  readonly verdict: ReviewVerdict;
  readonly reasons: readonly string[];
  readonly facts: ReviewFacts;
}

export type AnalystSkipReason =
  | "provenance"
  | "model_off"
  | "rate_limited"
  | "cap"
  | "refused"
  | "error"
  /** The loan is on a servicer's book and nobody has claimed it: there is no card to write for. */
  | "unclaimed";

/** What the review row keeps: the turn as written, or why there is none. */
export type AnalystRecord =
  | {
      readonly rationale: string;
      readonly flags: AnalystFlag[];
      /** 1 as written; 0.75 when the guard sent it back once. */
      readonly confidence: number;
      readonly model: string;
      readonly prompt_version: string;
      readonly prompt_hash: string;
      readonly context_hash: string;
      readonly regenerated: boolean;
      readonly requests: number;
      readonly tokens: { readonly input: number; readonly output: number };
    }
  | {
      readonly skipped: AnalystSkipReason;
      readonly detail?: string;
      readonly model?: string;
      readonly prompt_version: string;
    };

/* ── the two tools ─────────────────────────────────────────────────────── */

export const REVIEW_FACTS_TOOL = "review_facts";
export const REVIEW_WRITE_TOOL = "review_write";

export const ANALYST_MODEL_TOOLS: readonly Anthropic.Tool[] = [
  {
    name: REVIEW_FACTS_TOOL,
    description:
      "The day's review facts for this loan as {{facts.<key>}} tokens (the surface fills them; you never see or write the figures), with the engine's verdict and its reasons in words. Call it first, once.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: REVIEW_WRITE_TOOL,
    description:
      "Write the analyst's rationale and flags for the day's review. rationale: one to three sentences in the homeowner's language that state the verdict's reason, with every figure as a {{facts.<key>}} token from review_facts and no digit, amount or percentage of your own. flags: only codes from the allowed list. Nothing else — the verdict, the rate and every figure are the engine's.",
    input_schema: {
      type: "object",
      properties: {
        rationale: { type: "string" },
        flags: { type: "array", items: { type: "string", enum: [...ANALYST_FLAGS] } },
      },
      required: ["rationale", "flags"],
      additionalProperties: false,
    },
  },
];

/** What `review_facts` answers the model: tokens and words, no figure. */
export interface AnalystFactsResult {
  readonly verdict: ReviewVerdict;
  readonly verdict_text: string;
  readonly reasons_text: string[];
  readonly facts: Record<string, string>;
  readonly value_source: string;
  readonly value_confidence: string;
  readonly flags: string[];
  readonly allowed_flags: string[];
  readonly text: string;
}

const sourceWords = (s: ReviewFacts["value_source"]): string =>
  s === "partner_fmv"
    ? "the partner's current market value"
    : s === "partner_bpo"
      ? "the partner's broker price opinion"
      : "the partner's original appraisal";

export function analystFactsResult(i: {
  verdict: ReviewVerdict;
  reasons: readonly string[];
  facts: ReviewFacts;
}): AnalystFactsResult {
  const f = i.facts;
  const t = reviewTokens(f);
  const reasons_text = reasonsInWords(i.reasons);
  const facts: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) if (v) facts[k] = v;
  const parts = [
    `The engine's verdict is ${i.verdict.replace(/_/g, " ")} (${VERDICT_WORDS[i.verdict]}).`,
    `Reasons: ${reasons_text.join("; ") || "none"}.`,
    `The rate now is ${t.rate_now}${
      t.candidate_rate
        ? ` and today's candidate rate is ${t.candidate_rate} (a change of ${t.rate_delta})`
        : ""
    }.`,
    `The balance is ${t.upb} against a value of ${t.value} (${sourceWords(f.value_source)}, as of ${t.value_as_of}, ${f.value_confidence} confidence), a loan-to-value of ${t.ltv}, with ${t.remaining_term} left.`,
    `The payment now is ${t.payment_now}${
      t.candidate_payment
        ? `; the candidate payment would be ${t.candidate_payment}, a monthly change of ${t.monthly_delta}, savings over the holding period of ${t.npv}, a total-cost change over seven years of ${t.seven_year_delta}${
            t.breakeven ? ` and a breakeven of ${t.breakeven}` : ""
          }`
        : ""
    }.`,
    `Days delinquent: ${t.days_delinquent}.`,
    ...(t.watch_rate
      ? [`The rate the sheet would need to show for the numbers to work is ${t.watch_rate}.`]
      : []),
    ...(f.flags.length
      ? [`Flags on the facts: ${f.flags.map((x) => x.replace(/_/g, " ")).join(", ")}.`]
      : []),
  ];
  const text = parts.join(" ");
  for (const s of [text, ...reasons_text, VERDICT_WORDS[i.verdict]]) {
    const v = provenanceViolation(s);
    if (v) throw new RangeError(`review_facts text carries ${v}`);
  }
  return {
    verdict: i.verdict,
    verdict_text: VERDICT_WORDS[i.verdict],
    reasons_text,
    facts,
    value_source: f.value_source,
    value_confidence: f.value_confidence,
    flags: [...f.flags],
    allowed_flags: [...ANALYST_FLAGS],
    text,
  };
}

/** `review_write`'s input as the analyst may give it: `{rationale, flags[]}` only. */
export type AnalystWrite = { readonly rationale: string; readonly flags: AnalystFlag[] };
export type AnalystWriteRefusal = {
  readonly error: "ANALYST_NEVER_DECIDES" | "BAD_FLAGS" | "BAD_INPUT";
  readonly message: string;
};
const WRITE_KEYS = new Set(["rationale", "flags"]);
const NUMBER_TEXT = /^\s*-?\$?\d[\d,]*(\.\d+)?\s*(%|bps|basis points)?\s*$/i;

export function validateAnalystWrite(input: P): AnalystWrite | AnalystWriteRefusal {
  const extra = Object.keys(input).filter((k) => !WRITE_KEYS.has(k));
  if (extra.length) {
    return {
      error: "ANALYST_NEVER_DECIDES",
      message: `review_write takes {rationale, flags[]} only — \`${extra.join("`, `")}\` is the engine's to decide (the verdict, the rate and every figure are read from the engine's rows)`,
    };
  }
  const r = input["rationale"];
  if (typeof r !== "string" || !r.trim()) {
    return { error: "BAD_INPUT", message: "rationale must be one to three sentences of text" };
  }
  if (NUMBER_TEXT.test(r)) {
    return {
      error: "ANALYST_NEVER_DECIDES",
      message: "the rationale is a number — figures are the engine's; use the {{facts.*}} tokens",
    };
  }
  const flagsIn = input["flags"] ?? [];
  if (!Array.isArray(flagsIn)) {
    return { error: "BAD_INPUT", message: "flags must be an array of codes from the allowed list" };
  }
  const flags: AnalystFlag[] = [];
  const bad: string[] = [];
  for (const x of flagsIn) {
    const s = String(x);
    if ((ANALYST_FLAGS as readonly string[]).includes(s)) {
      if (!flags.includes(s as AnalystFlag)) flags.push(s as AnalystFlag);
    } else bad.push(s);
  }
  if (bad.length) {
    return {
      error: "BAD_FLAGS",
      message: `flags outside the analyst's list: ${bad.join(", ")} (allowed: ${ANALYST_FLAGS.join(", ")})`,
    };
  }
  return { rationale: r.trim(), flags };
}

/* ── the provenance guard (his guard.ts, the one rule the analyst needs) ── */

const TOKEN = /\{\{[a-zA-Z0-9_.:-]+\}\}/g;
const SPELLED = /\b(?:hundred|thousand|million|billion|percent|per\s?cent|dollars?|bucks|cents)\b/i;
const NUMBER_WORDS =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|point|and))+/i;

/** A figure outside a token, named; null for a text the surface can stand behind. */
export function provenanceViolation(text: string): string | null {
  const bare = text.replace(TOKEN, " ");
  const digit = /\S*\d\S*/.exec(bare);
  if (digit) return `a raw figure "${digit[0]}" outside a {{token}}`;
  const spelled = SPELLED.exec(bare);
  if (spelled) return `a spelled-out amount or percentage ("${spelled[0]}") outside a {{token}}`;
  const words = NUMBER_WORDS.exec(bare);
  if (words) return `a spelled-out number ("${words[0]}") outside a {{token}}`;
  return null;
}

/** His provenance rule, and ours beside it: a token the facts cannot fill. */
export function rationaleViolation(text: string, facts: ReviewFacts): string | null {
  const v = provenanceViolation(text);
  if (v) return v;
  const unknown = unknownTokens(text, facts);
  if (unknown.length) {
    return `a token review_facts did not give you ({{${unknown[0]}}}); use only the tokens it listed`;
  }
  return null;
}

/* ── the prompt ────────────────────────────────────────────────────────── */

export const ANALYST_SYSTEM_PROMPT = [
  "You are the refinance analyst for a partner's book of monitored home loans. Each morning the engine reviews every loan and decides the verdict: a candidate for a refinance offer, watching (the rate is not there yet), not now, or excluded. You never decide. You read the engine's facts and write the reason in plain words for the homeowner and for an examiner.",
  "Do exactly this: call review_facts once, then call review_write once with a rationale of one to three sentences in the homeowner's language that states the verdict's reason, and flags from the allowed list only (an empty list when none applies). At most these two tool calls.",
  "Figures: only as the {{facts.<key>}} tokens review_facts gives you, copied exactly (for example {{facts.rate_now}} or {{facts.monthly_delta}}). Never write a digit, an amount, a percentage or a spelled-out number of your own; the surface fills the tokens. A rationale with a figure outside a token is refused.",
  "Never name a credit score, a credit report, an automated underwriting result or an approval; never say approved, pre-approved, guaranteed, denied, or that the homeowner does or does not qualify. Do not restate the verdict as a decision of yours: it is the engine's.",
  "If the guard returns your rationale with a violation named, write it again without the problem — reply with the rationale alone, or call review_write again if you still may.",
].join("\n\n");

export function analystUserMessage(review: AnalystReviewInput): string {
  return [
    "[review]",
    `Daily review of a monitored loan as of ${review.as_of_date} (loan ${review.loan_id}).`,
    `The engine's verdict is ${review.verdict.replace(/_/g, " ")} — ${VERDICT_WORDS[review.verdict]}.`,
    `Reasons: ${reasonsInWords(review.reasons).join("; ") || "none"}.`,
    "Call review_facts, then review_write.",
  ].join("\n");
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const ANALYST_PROMPT_HASH = sha256(ANALYST_SYSTEM_PROMPT);

const guardMessage = (violation: string): string =>
  `[guard]\nYour rationale was not accepted: ${violation}\nWrite it again with every figure as a {{facts.<key>}} token and no digit, amount or spelled-out number of your own — reply with the rationale alone (one to three sentences), or call review_write again.`;

/* ── the model ─────────────────────────────────────────────────────────── */

export interface ModelToolResult {
  readonly result: unknown;
  readonly is_error?: boolean;
}
export type ModelToolExecutor = (name: string, input: P, id: string) => Promise<ModelToolResult>;

export interface ModelTurnInput {
  readonly system: string;
  readonly messages: Anthropic.MessageParam[];
  readonly tools: readonly Anthropic.Tool[];
  readonly execute: ModelToolExecutor;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
}
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: P;
  readonly is_error: boolean;
}
export interface ModelTurnOutput {
  readonly text: string;
  readonly calls: readonly ModelToolCall[];
  readonly refused: boolean;
  readonly stop_reason: string | null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  /** The transcript as the model saw it, ending with the tool results, for the regeneration to continue. */
  readonly messages: Anthropic.MessageParam[];
  readonly requests: number;
  readonly model: string;
}

/** What the turn needs of a model: a name for the record, and one turn over the tools. */
export interface AnalystModel {
  readonly model: string;
  turn(input: ModelTurnInput): Promise<ModelTurnOutput>;
}

/**
 * The Anthropic API as the analyst's model: a manual loop over
 * `messages.create`, because the turn owns its own tool budget and its own
 * guard, and neither fits a runner's shape. Thinking is left to the model's
 * default (adaptive on Claude Opus 5); the effort is low, as his is.
 */
export class AnthropicAnalystModel implements AnalystModel {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { client: Anthropic; model?: string }) {
    this.client = opts.client;
    this.model = opts.model ?? DEFAULT_ANALYST_MODEL;
  }

  async turn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    const messages: Anthropic.MessageParam[] = [...input.messages];
    const calls: ModelToolCall[] = [];
    const texts: string[] = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let requests = 0;
    let stop: string | null = null;
    let budget = input.maxToolCalls;
    // One request per tool round and one to answer in text once the budget
    // is spent: with `tool_choice: none` the model cannot ask for a third
    // call, so the loop ends on a text turn rather than on a refused tool.
    for (let round = 0; round <= input.maxToolCalls; round += 1) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages,
        tools: [...input.tools],
        ...(budget <= 0 ? { tool_choice: { type: "none" } } : {}),
        output_config: { effort: "low" },
      });
      requests += 1;
      stop = response.stop_reason ?? null;
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      if (response.stop_reason === "refusal") {
        return {
          text: "",
          calls,
          refused: true,
          stop_reason: stop,
          usage,
          messages,
          requests,
          model: this.model,
        };
      }
      messages.push({ role: "assistant", content: response.content });
      const uses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      for (const b of response.content) if (b.type === "text") texts.push(b.text);
      if (response.stop_reason !== "tool_use" || uses.length === 0) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const args = (use.input ?? {}) as P;
        if (budget <= 0) {
          calls.push({ id: use.id, name: use.name, input: args, is_error: true });
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify({
              error: "TOOL_BUDGET",
              message: "no tool calls left this turn",
            }),
            is_error: true,
          });
          continue;
        }
        budget -= 1;
        const r = await input.execute(use.name, args, use.id);
        calls.push({ id: use.id, name: use.name, input: args, is_error: Boolean(r.is_error) });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(r.result),
          ...(r.is_error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
    }
    return {
      text: texts.join(" "),
      calls,
      refused: false,
      stop_reason: stop,
      usage,
      messages,
      requests,
      model: this.model,
    };
  }
}

/** The deploy's model: ANTHROPIC_API_KEY and REFI_ANALYST_MODEL; null without a key, and every turn is then `model_off`. */
export function analystModelFromEnv(
  env: Record<string, string | undefined> = process.env,
): AnalystModel | null {
  const apiKey = (env["ANTHROPIC_API_KEY"] ?? "").trim();
  if (!apiKey) return null;
  return new AnthropicAnalystModel({
    client: new Anthropic({ apiKey }),
    model: (env["REFI_ANALYST_MODEL"] ?? "").trim() || DEFAULT_ANALYST_MODEL,
  });
}

export function analystMaxPerDay(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env["REFI_ANALYST_MAX_PER_DAY"] ?? DEFAULT_ANALYST_MAX_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ANALYST_MAX_PER_DAY;
}

/* ── the run: two tools, the guard, one regeneration; no database ──────── */

export interface AnalystModelRun {
  readonly outcome: "written" | "provenance" | "refused" | "no_write";
  readonly rationale: string | null;
  readonly flags: AnalystFlag[];
  readonly regenerated: boolean;
  readonly first_violation: string | null;
  readonly detail: string | null;
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly requests: number;
  readonly model: string;
  readonly context_hash: string;
  /** Every `review_facts` result handed to the model; tests assert no raw figure. */
  readonly facts_results: AnalystFactsResult[];
}

const rationaleOf = (
  out: ModelTurnOutput,
  writes: Map<string, AnalystWrite>,
  textStandsIn: boolean,
): { rationale: string | null; flags: AnalystFlag[] | null } => {
  const accepted = out.calls.filter(
    (c) => c.name === REVIEW_WRITE_TOOL && !c.is_error && writes.has(c.id),
  );
  const last = accepted.at(-1);
  if (last) {
    const w = writes.get(last.id)!;
    return { rationale: w.rationale, flags: w.flags };
  }
  // The regeneration asked for the rationale as the reply: the text stands
  // in for a review_write call.
  return { rationale: textStandsIn && out.text.trim() ? out.text.trim() : null, flags: null };
};

export async function runAnalystModel(
  model: AnalystModel,
  review: AnalystReviewInput,
  opts: { readonly maxToolCalls?: number } = {},
): Promise<AnalystModelRun> {
  const facts_results: AnalystFactsResult[] = [];
  const writes = new Map<string, AnalystWrite>();
  let writeRefusals: string[] = [];
  const execute: ModelToolExecutor = async (name, input, id) => {
    if (name === REVIEW_FACTS_TOOL) {
      const r = analystFactsResult(review);
      facts_results.push(r);
      return { result: r };
    }
    if (name !== REVIEW_WRITE_TOOL) {
      return {
        result: { error: "TOOL_UNKNOWN", message: `${name} is not a tool of this turn` },
        is_error: true,
      };
    }
    const v = validateAnalystWrite(input);
    if ("error" in v) {
      writeRefusals = [...writeRefusals, v.error];
      return { result: { error: v.error, refused: true, message: v.message }, is_error: true };
    }
    writes.set(id, v);
    return {
      result: {
        accepted: true,
        flags: v.flags,
        note: "the rationale is checked for provenance when the turn ends; the review row is written by the pass",
      },
    };
  };
  const system = ANALYST_SYSTEM_PROMPT;
  const user = analystUserMessage(review);
  const maxToolCalls = opts.maxToolCalls ?? ANALYST_MAX_TOOL_CALLS;
  const input: ModelTurnInput = {
    system,
    messages: [{ role: "user", content: user }],
    tools: ANALYST_MODEL_TOOLS,
    execute,
    maxToolCalls,
    maxTokens: ANALYST_MAX_TOKENS,
  };
  const context_hash = sha256(`${system}\n\n${user}\n\n${JSON.stringify(ANALYST_MODEL_TOOLS)}`);
  const base = (out: ModelTurnOutput) => ({
    usage: out.usage,
    requests: out.requests,
    model: out.model,
    context_hash,
    facts_results,
  });

  const first = await model.turn(input);
  if (first.refused) {
    return {
      outcome: "refused",
      rationale: null,
      flags: [],
      regenerated: false,
      first_violation: null,
      detail: "the model refused",
      ...base(first),
    };
  }
  const w1 = rationaleOf(first, writes, false);
  if (w1.rationale === null) {
    const detail = writeRefusals.length
      ? `review_write refused: ${writeRefusals.join(", ")}`
      : "the model did not call review_write";
    return {
      outcome: "no_write",
      rationale: null,
      flags: [],
      regenerated: false,
      first_violation: null,
      detail,
      ...base(first),
    };
  }
  const v1 = rationaleViolation(w1.rationale, review.facts);
  if (!v1) {
    return {
      outcome: "written",
      rationale: w1.rationale,
      flags: w1.flags ?? [],
      regenerated: false,
      first_violation: null,
      detail: null,
      ...base(first),
    };
  }

  // The one regeneration: the rejected rationale and the violation go back
  // as the next exchange; the tool budget continues from where it stood.
  const messages: Anthropic.MessageParam[] = [
    ...first.messages,
    { role: "user", content: guardMessage(v1) },
  ];
  const remaining = Math.max(1, maxToolCalls - first.calls.length);
  const second = await model.turn({ ...input, messages, maxToolCalls: remaining });
  const merged: ModelTurnOutput = {
    ...second,
    calls: [...first.calls, ...second.calls],
    usage: {
      input_tokens: first.usage.input_tokens + second.usage.input_tokens,
      output_tokens: first.usage.output_tokens + second.usage.output_tokens,
    },
    requests: first.requests + second.requests,
  };
  if (second.refused) {
    return {
      outcome: "refused",
      rationale: null,
      flags: w1.flags ?? [],
      regenerated: true,
      first_violation: v1,
      detail: "the model refused the regeneration",
      ...base(merged),
    };
  }
  const w2 = rationaleOf(second, writes, true);
  const flags = w2.flags ?? w1.flags ?? [];
  const v2 =
    w2.rationale === null
      ? "no rationale in the regeneration"
      : rationaleViolation(w2.rationale, review.facts);
  if (v2) {
    return {
      outcome: "provenance",
      rationale: null,
      flags,
      regenerated: true,
      first_violation: v1,
      detail: `${v1}; then ${v2}`,
      ...base(merged),
    };
  }
  return {
    outcome: "written",
    rationale: w2.rationale,
    flags,
    regenerated: true,
    first_violation: v1,
    detail: `first attempt: ${v1}`,
    ...base(merged),
  };
}

const isRateLimited = (e: unknown): boolean => {
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return status === 429 || status === 529 || status === 503 || /overloaded/i.test(e.message);
  }
  return false;
};

export interface AnalystTurnOptions {
  /** The turns the pass has already taken today, and its cap. */
  readonly turnsToday?: number;
  readonly maxPerDay?: number;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * The analyst's turn for one loan-day, as the review row keeps it. Never
 * throws: the model being off, the cap, a rate limit, a refusal and every
 * other failure are skip reasons, and the review is written the same.
 */
export async function analystTurn(
  model: AnalystModel | null | undefined,
  review: AnalystReviewInput,
  opts: AnalystTurnOptions = {},
): Promise<AnalystRecord> {
  const prompt_version = ANALYST_PROMPT_VERSION;
  if (!model) return { skipped: "model_off", prompt_version };
  if ((opts.turnsToday ?? 0) >= (opts.maxPerDay ?? DEFAULT_ANALYST_MAX_PER_DAY)) {
    return { skipped: "cap", prompt_version, model: model.model };
  }
  let run: AnalystModelRun;
  try {
    run = await runAnalystModel(model, review);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isRateLimited(e)) {
      opts.log?.("refi analyst: rate limited", { loan_id: review.loan_id, error: message });
      return { skipped: "rate_limited", detail: message, prompt_version, model: model.model };
    }
    opts.log?.("refi analyst: model failed", { loan_id: review.loan_id, error: message });
    return { skipped: "error", detail: message, prompt_version, model: model.model };
  }
  opts.log?.("refi analyst turn", {
    loan_id: review.loan_id,
    as_of_date: review.as_of_date,
    verdict: review.verdict,
    outcome: run.outcome,
    model: run.model,
    regenerated: run.regenerated,
    requests: run.requests,
    tokens_in: run.usage.input_tokens,
    tokens_out: run.usage.output_tokens,
  });
  if (run.outcome !== "written") {
    const skipped: AnalystSkipReason =
      run.outcome === "provenance" ? "provenance" : run.outcome === "refused" ? "refused" : "error";
    return {
      skipped,
      ...(run.detail ? { detail: run.detail } : {}),
      prompt_version,
      model: run.model,
    };
  }
  return {
    rationale: run.rationale!,
    flags: [...run.flags],
    confidence: run.regenerated ? 0.75 : 1,
    model: run.model,
    prompt_version,
    prompt_hash: ANALYST_PROMPT_HASH,
    context_hash: run.context_hash,
    regenerated: run.regenerated,
    requests: run.requests,
    tokens: { input: run.usage.input_tokens, output: run.usage.output_tokens },
  };
}

/** Whether a model actually ran for this record — what counts under the day's cap. */
export function analystModelRan(record: AnalystRecord): boolean {
  if (!("skipped" in record)) return true;
  return (
    record.skipped === "provenance" || record.skipped === "refused" || record.skipped === "error"
  );
}
