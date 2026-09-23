/**
 * The refinance analyst's turn, over a scripted model.
 *
 * What is held here is the seam Doug's rule 4 draws: the model sees tokens
 * and never a figure, writes a rationale and flags and nothing else, is sent
 * back once when it writes a number of its own, and is skipped — never the
 * review — when it fails twice, refuses, decides, is rate limited, is off,
 * or the day's cap is reached. The model itself is a script.
 */

import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { plainDate } from "@hm/kernel/calendar";
import type { ReviewFacts } from "@hm/refi-review";
import { fillReviewTokens } from "@hm/refi-review";
import {
  ANALYST_PROMPT_VERSION,
  AnthropicAnalystModel,
  analystFactsResult,
  analystTurn,
  provenanceViolation,
  rationaleViolation,
  runAnalystModel,
  validateAnalystWrite,
  type AnalystReviewInput,
} from "../services/refi-analyst.js";

const FACTS: ReviewFacts = {
  note_rate_pct: "7.250",
  candidate_rate_pct: "6.250",
  rate_delta_bps: -100,
  upb_cents: "44096293",
  value_cents: "62000000",
  value_source: "partner_fmv",
  value_as_of: plainDate("2026-08-15"),
  value_confidence: "medium",
  ltv: "0.7150",
  remaining_term_months: 348,
  pi_cents: "306979",
  candidate_pi_cents: "273100",
  candidate_loan_amount_cents: "44400000",
  monthly_delta_cents: "-33879",
  npv_cents: "1512000",
  breakeven_months: 14,
  seven_year_delta_cents: "-2200000",
  days_delinquent: 0,
  flags: [],
};

const REVIEW: AnalystReviewInput = {
  loan_id: "loan-1",
  as_of_date: "2026-09-23",
  verdict: "candidate",
  reasons: ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen"],
  facts: FACTS,
};

/** One scripted assistant turn: tool calls and text, as the API would answer. */
type Scene =
  | { tools: { name: string; input: Record<string, unknown> }[]; text?: string }
  | { text: string }
  | { refusal: true }
  | { throws: Error };

function scriptedClient(scenes: Scene[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  let ids = 0;
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(params);
        const scene = scenes[i++];
        if (!scene) throw new Error(`no scene for request ${i}`);
        if ("throws" in scene) throw scene.throws;
        const usage = { input_tokens: 100, output_tokens: 20 };
        if ("refusal" in scene) {
          return {
            id: "m",
            type: "message",
            role: "assistant",
            model: "scripted",
            content: [],
            stop_reason: "refusal",
            stop_sequence: null,
            usage,
          };
        }
        const content: Anthropic.ContentBlock[] = [];
        if (scene.text) content.push({ type: "text", text: scene.text, citations: null });
        const tools = "tools" in scene ? scene.tools : [];
        for (const t of tools) {
          content.push({
            type: "tool_use",
            id: `tu-${++ids}`,
            name: t.name,
            input: t.input,
          } as Anthropic.ToolUseBlock);
        }
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "scripted",
          content,
          stop_reason: tools.length ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage,
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const model = (scenes: Scene[]) => {
  const s = scriptedClient(scenes);
  return {
    model: new AnthropicAnalystModel({ client: s.client, model: "scripted" }),
    requests: s.requests,
  };
};

const GOOD =
  "Your rate is {{facts.rate_now}} and today's candidate is {{facts.candidate_rate}}, which would change your monthly payment by {{facts.monthly_delta}}.";

describe("the analyst's tools", () => {
  it("hands the model tokens and words, never a figure", () => {
    const r = analystFactsResult(REVIEW);
    expect(r.facts.rate_now).toBe("{{facts.rate_now}}");
    expect(r.facts.monthly_delta).toBe("{{facts.monthly_delta}}");
    expect(r.facts.watch_rate).toBeUndefined();
    expect(provenanceViolation(r.text)).toBeNull();
    expect(r.text).not.toContain("7.25");
    expect(r.reasons_text[0]).toBe("the rate reduction clears the program's floor");
    expect(r.allowed_flags).toContain("high_ltv");
  });

  it("takes {rationale, flags[]} and refuses everything the engine decides", () => {
    expect(validateAnalystWrite({ rationale: GOOD, flags: ["high_ltv", "high_ltv"] })).toEqual({
      rationale: GOOD,
      flags: ["high_ltv"],
    });
    expect(
      validateAnalystWrite({ rationale: GOOD, flags: [], verdict: "candidate" }),
    ).toMatchObject({
      error: "ANALYST_NEVER_DECIDES",
    });
    expect(validateAnalystWrite({ rationale: "6.25%", flags: [] })).toMatchObject({
      error: "ANALYST_NEVER_DECIDES",
    });
    expect(validateAnalystWrite({ rationale: GOOD, flags: ["made_up"] })).toMatchObject({
      error: "BAD_FLAGS",
    });
    expect(validateAnalystWrite({ rationale: "", flags: [] })).toMatchObject({
      error: "BAD_INPUT",
    });
  });

  it("names a figure outside a token, a spelled-out amount, and a token the facts cannot fill", () => {
    expect(provenanceViolation(GOOD)).toBeNull();
    expect(provenanceViolation("You would save about $338 a month.")).toContain("$338");
    expect(provenanceViolation("You would save a few hundred dollars.")).toContain("hundred");
    expect(provenanceViolation("Rates fell by twenty-five basis points.")).toContain("twenty-five");
    expect(rationaleViolation("The sheet would need {{facts.watch_rate}}.", FACTS)).toContain(
      "{{facts.watch_rate}}",
    );
    expect(rationaleViolation(GOOD, FACTS)).toBeNull();
  });
});

describe("the analyst's turn", () => {
  it("reads the facts, writes the rationale, and the page fills the tokens", async () => {
    const m = model([
      { tools: [{ name: "review_facts", input: {} }] },
      { tools: [{ name: "review_write", input: { rationale: GOOD, flags: [] } }] },
      { text: "Done." },
    ]);
    const run = await runAnalystModel(m.model, REVIEW);
    expect(run.outcome).toBe("written");
    expect(run.rationale).toBe(GOOD);
    expect(run.regenerated).toBe(false);
    expect(run.facts_results).toHaveLength(1);
    expect(run.requests).toBe(3);
    // The prompt is his, the effort is low, and the third request could not call a tool.
    expect(m.requests[0]?.model).toBe("scripted");
    expect(m.requests[0]?.output_config).toEqual({ effort: "low" });
    expect(m.requests[2]?.tool_choice).toEqual({ type: "none" });

    const fresh = model([
      { tools: [{ name: "review_facts", input: {} }] },
      { tools: [{ name: "review_write", input: { rationale: GOOD, flags: [] } }] },
      { text: "Done." },
    ]);
    const record = await analystTurn(fresh.model, REVIEW);
    expect(record).toMatchObject({ confidence: 1, prompt_version: ANALYST_PROMPT_VERSION });
    const filled = fillReviewTokens((record as { rationale: string }).rationale, FACTS);
    expect(filled).toBe(
      "Your rate is 7.25% and today's candidate is 6.25%, which would change your monthly payment by -$338.79.",
    );
  });

  it("sends a rationale with a figure of its own back once, and takes the rewrite at lower confidence", async () => {
    const bad = "Your rate is 7.25% and a refinance would cut it.";
    const m = model([
      { tools: [{ name: "review_facts", input: {} }] },
      { tools: [{ name: "review_write", input: { rationale: bad, flags: ["high_ltv"] } }] },
      { text: "Written." },
      // The regeneration: the rationale as the reply, no tool call.
      { text: GOOD },
    ]);
    const run = await runAnalystModel(m.model, REVIEW);
    expect(run.outcome).toBe("written");
    expect(run.rationale).toBe(GOOD);
    expect(run.regenerated).toBe(true);
    expect(run.first_violation).toContain("7.25%");
    expect(run.flags).toEqual(["high_ltv"]);
    // The guard's message reached the model, naming the violation.
    const guard = m.requests
      .at(-1)!
      .messages.find((x) => typeof x.content === "string" && x.content.startsWith("[guard]"));
    expect(guard).toBeDefined();
    expect(String(guard!.content)).toContain("7.25%");
    // Taken, at the lower confidence a rewrite carries.
    const again = model([
      { tools: [{ name: "review_facts", input: {} }] },
      { tools: [{ name: "review_write", input: { rationale: bad, flags: [] } }] },
      { text: "Written." },
      { text: GOOD },
    ]);
    expect(await analystTurn(again.model, REVIEW)).toMatchObject({
      rationale: GOOD,
      confidence: 0.75,
      regenerated: true,
    });
  });

  it("skips the turn, never the review, when the rewrite fails too", async () => {
    const m = model([
      { tools: [{ name: "review_facts", input: {} }] },
      { tools: [{ name: "review_write", input: { rationale: "About $300 a month.", flags: [] } }] },
      { text: "ok" },
      { text: "Roughly three hundred dollars a month." },
    ]);
    const record = await analystTurn(m.model, REVIEW);
    expect(record).toMatchObject({ skipped: "provenance" });
    expect((record as { detail: string }).detail).toContain("then");
  });

  it("skips when the model tries to decide instead of write, and when it refuses", async () => {
    const decides = model([
      { tools: [{ name: "review_facts", input: {} }] },
      {
        tools: [
          { name: "review_write", input: { rationale: GOOD, flags: [], verdict: "not_now" } },
        ],
      },
      { text: "I set the verdict." },
    ]);
    expect(await analystTurn(decides.model, REVIEW)).toMatchObject({
      skipped: "error",
      detail: "review_write refused: ANALYST_NEVER_DECIDES",
    });

    const refuses = model([{ refusal: true }]);
    expect(await analystTurn(refuses.model, REVIEW)).toMatchObject({ skipped: "refused" });
  });

  it("is off without a model, capped for the day, and quiet under a rate limit", async () => {
    expect(await analystTurn(null, REVIEW)).toEqual({
      skipped: "model_off",
      prompt_version: ANALYST_PROMPT_VERSION,
    });
    const m = model([]);
    expect(await analystTurn(m.model, REVIEW, { turnsToday: 500, maxPerDay: 500 })).toMatchObject({
      skipped: "cap",
    });
    expect(m.requests).toHaveLength(0);

    const limited = model([
      {
        throws: new Anthropic.RateLimitError(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
          "slow down",
          new Headers(),
        ),
      },
    ]);
    expect(await analystTurn(limited.model, REVIEW)).toMatchObject({ skipped: "rate_limited" });
    const down = model([{ throws: new Error("socket hang up") }]);
    expect(await analystTurn(down.model, REVIEW)).toMatchObject({ skipped: "error" });
  });

  it("never gives the model a third tool call", async () => {
    const m = model([
      { tools: [{ name: "review_facts", input: {} }] },
      { tools: [{ name: "review_facts", input: {} }] },
      // The budget is spent: this request carries tool_choice none, and the
      // script answers in text, so nothing was written.
      { text: "I looked twice." },
    ]);
    const run = await runAnalystModel(m.model, REVIEW);
    expect(run.outcome).toBe("no_write");
    expect(m.requests[2]?.tool_choice).toEqual({ type: "none" });
    expect(run.facts_results).toHaveLength(2);
  });
});
