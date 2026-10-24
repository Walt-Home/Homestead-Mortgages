/**
 * The call rubric and call-qa: the rubric runs the servicing app's own
 * provenance and verbatim checks (the ports are its files but for the
 * imports) beside the collections spec's rules, and every word list and gate
 * it restates is held to the servicing app's own line; it finds nothing on
 * the contact center's calls as they were said but the dialer's own breaches,
 * and finds each planted defect where it was planted, where the record can
 * show it; the rulebook a model is told is pinned and states each rule the
 * way the rubric applies it; the spec's own examples give the spec's
 * findings; every generated call can be reviewed from the rulebook and the
 * tools; the grader charges for what is missed and for what is not there;
 * and every item, edge and verdict turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { defaultCalibration, generate } from "../life/index.js";
import {
  CONTACT_DEFECTS,
  callPlan,
  callsOf,
  contactCenter,
  plantContactDefects,
  type ContactDefectId,
} from "../contacts/index.js";
import {
  AUTOMATIC_FAILS,
  CALL_TEMPLATES,
  COLLECTION_PHRASES,
  COPY_LINE,
  COMPLAINT_PHRASES,
  CREDIT_MISSTATEMENT_PHRASES,
  NEGOTIATION_PHRASES,
  OPTIONS,
  OPTION_PHRASES,
  RECORDING_PHRASES,
  RUBRIC_ITEMS,
  THREAT_PHRASES,
  THREAT_WORDS,
  failedPreDialChecks,
  normalizeLine,
  reviewCall,
  says,
  threatens,
  within,
  type PreDialFacts,
  type RubricItem,
} from "../calls/index.js";
import {
  CALL_QA_EDGES,
  CALL_QA_FINGERPRINT,
  CALL_QA_HELDOUT_SUITE,
  CALL_QA_RULEBOOK,
  CALL_QA_SPEC_CASES,
  CallQaReferencePolicy,
  LINE_ITEMS,
  callQa,
  callQaArmOf,
  callQaEdgeOf,
  callQaPayload,
  callQaSpecTasks,
  callQaSteps,
  callQaTaskId,
  callQaVerdict,
  drawCallQaTask,
  executeCallQaTool,
  expectedCallQa,
  generateCallQaSuite,
  generateCallQaTask,
  gradeCallQaAgainst,
  judge,
  parseCallQaSubmission,
  phraseList,
  rebuild,
  recordFor,
  reviewContactCall,
  type CallQaAnswer,
  type CallQaTask,
} from "../call-qa/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const servicingFile = (path: string) =>
  readFileSync(here(`../../../../apps/servicing/${path}`), "utf8");
const servicing = (path: string) => servicingFile(`src/${path}`).split("\n");
/** The line a citation names holds this text. */
const lineHas = (path: string, line: number, text: string) =>
  expect(servicing(path)[line - 1], `${path}:${line}`).toContain(text);
const imports = (text: string) => text.split("\n").filter((l) => l.startsWith("import "));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");

/** The fields where the rulebook, followed through the tools, lands somewhere other than the grader. */
const byRulesMisses = (task: CallQaTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(callQaSteps, JSON.parse(JSON.stringify(callQaPayload(task))), (n, i) =>
      executeCallQaTool(n, i, task),
    );
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseCallQaSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradeCallQaAgainst(expectedCallQa(task), parsed.answer)
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const solveAll = async (tasks: readonly CallQaTask[]) => {
  const misses: string[] = [];
  let calls = 0;
  let turns = 0;
  for (const task of tasks) {
    const r = await runEpisode(callQa, task, new CallQaReferencePolicy());
    calls = Math.max(calls, r.tool_calls);
    turns = Math.max(turns, r.turns);
    if (!r.grade.pass)
      misses.push(
        `${task.id} ${r.outcome} ${r.error ?? ""} ${r.grade.fields
          .filter((f) => !f.ok)
          .map((f) => `${f.field} ${f.expected}/${f.got}`)
          .join("; ")}`,
      );
  }
  return { misses, calls, turns };
};

const SPEC = callQaSpecTasks();
/** The held-out suite, drawn once: each draw with how many attempts it took. */
let heldDraws: ReturnType<typeof drawCallQaTask>[] | null = null;
const heldout = () =>
  (heldDraws ??= Array.from({ length: CALL_QA_HELDOUT_SUITE.n }, (_, i) =>
    drawCallQaTask(CALL_QA_HELDOUT_SUITE.split, CALL_QA_HELDOUT_SUITE.seed, i),
  ));
const heldTasks = () => heldout().map((x) => x.task);
const specTask = (prefix: string): CallQaTask => {
  const k = CALL_QA_SPEC_CASES.findIndex((c) => c.name.startsWith(prefix));
  if (k < 0) throw new Error(`no spec case ${prefix}`);
  return SPEC[k]!;
};
const keys = (a: CallQaAnswer) => a.findings.map((f) => `${f.item}@${f.line ?? "-"}`);

/** A book of the contact center's calls, clean, to hold the rubric to: a fifth of its loans file for bankruptcy. */
const cal = defaultCalibration();
const book = generate(11, { loans: 120, months: 48 }, { calibration: cal }).clean;
const center = contactCenter(book, {
  calibration: cal,
  pins: Object.fromEntries(
    book.loans.map((_, i) => [
      i,
      { language: "en" as const, ...(i % 5 === 0 ? { bankruptcy: true } : {}) },
    ]),
  ),
});
/** The calls v1 draws from: English and through no interpreter, recorded in stereo, not a welcome call. */
const reviewable = (c: { id: string; interpreter: boolean; purpose: string }, ctr = center) =>
  !c.interpreter && c.purpose !== "welcome" && callPlan(ctr, book, c.id).recording === "stereo";

describe("the call rubric", () => {
  it("runs the harness's provenance and verbatim checks: its types byte for byte, its checks' lines but for the imports", () => {
    const types = servicing("domain/borrower/eval/types.ts").join("\n");
    expect(readFileSync(here("../calls/ported/types.ts"), "utf8")).toBe(types);
    const original = servicing("domain/borrower/eval/checks.ts");
    const cut = original.findIndex((l) => l.includes("(3) SAFE and inquiries"));
    expect(cut).toBe(122);
    const head = original.slice(0, cut).join("\n");
    const port = readFileSync(here("../calls/ported/checks.ts"), "utf8");
    expect(withoutImports(port)).toBe(withoutImports(head) + "\n");
    // The import of ops-21-1.ts is dropped (only check (3) reads it); ./types.ts becomes ./types.js.
    expect(imports(head)).toHaveLength(2);
    expect(imports(head)[0]).toContain('from "../../application/ops-21-1.ts"');
    expect(imports(port)).toEqual([imports(head)[1]!.replace('"./types.ts"', '"./types.js"')]);
    // checks.ts:1-25 names the five checks; provenance and verbatim are the two this file carries.
    expect(original.slice(0, 25).join("\n")).toMatch(/provenance {3}every digit-run/);
    expect(original.slice(0, 25).join("\n")).toMatch(/verbatim {5}no agent message equals/);
  });

  it("holds the words and gates it restates to the servicing app's own lines", () => {
    // The threat words and the options (section11.ts:54-57).
    lineHas("app/tools/section11.ts", 57, `const THREAT_WORDS = ${THREAT_WORDS.toString()};`);
    lineHas(
      "app/tools/section11.ts",
      54,
      `"repayment plan", "payment deferral", "forbearance", "loan modification`,
    );
    lineHas("app/tools/section11.ts", 55, `"short sale", "Mortgage Release (deed-in-lieu)"`);
    // preDialChecks (section11.ts:84-105): the zones' local times, the window, consent and the landline cap, the cap.
    lineHas("app/tools/section11.ts", 84, "export function preDialChecks(");
    lineHas(
      "app/tools/section11.ts",
      91,
      "const local = tzs.map((tz) => { const w = wallClock(dialMs, tz);",
    );
    lineHas("app/tools/section11.ts", 92, 'local.every((l) => evaluateGate("11.1.quietHours"');
    lineHas("app/tools/section11.ts", 94, 'if (mode === "ai_voice" || mode === "sms") {');
    lineHas(
      "app/tools/section11.ts",
      95,
      'if (lineType === "landline" && mode === "ai_voice") { const g = f.written_consent === true ? { open: true } : evaluateGate("11.1.landlineAi3in30"',
    );
    lineHas("app/tools/section11.ts", 96, 'evaluateGate("11.1.tcpaConsentUnrevoked"');
    lineHas(
      "app/tools/section11.ts",
      99,
      'const overlay = stateOverlay({ state: String(f.state ?? ""), debt_collector: dc });',
    );
    lineHas("app/tools/section11.ts", 100, 'dc ? evaluateGate("11.1.callCap7in7"');
    lineHas(
      "app/tools/section11.ts",
      100,
      "const cap = overlay.contact_engine.call_cap_7d ?? 5; return cnt + 1 <= cap",
    );
    lineHas(
      "app/tools/section11.ts",
      104,
      "cease_flags: f.cease_active !== true && f.written_cease !== true",
    );
    lineHas(
      "app/tools/section11.ts",
      104,
      "bk_flag: f.bk_active !== true, attorney_flag: f.attorney_represented !== true",
    );
    lineHas("app/tools/section11.ts", 336, '"ONE_VOICEMAIL_PER_NUMBER_7D"');
    lineHas("app/tools/section11.ts", 336, 'num(i, "voicemails_to_number_7d") >= 1');
    lineHas("app/tools/section11.ts", 337, '"NO_DIRECT_CONTACT_WHEN_REPRESENTED"');
    // The evaluators (evaluators.ts:256-259) and the trailing window (evaluator-kit.ts:24).
    lineHas(
      "app/evaluators.ts",
      256,
      'atMost(within(f, "counted_call_attempts_at", 7, s(f, "now")) + 1, 7,',
    );
    lineHas("app/evaluators.ts", 257, 'const end = ch === "voice" ? "20:30" : "20:00";');
    lineHas("app/evaluators.ts", 257, '!(t > "08:00" && t <= end)');
    lineHas("app/evaluators.ts", 258, '"tcpa_voice_consent_active"');
    lineHas(
      "app/evaluators.ts",
      259,
      'atMost(within(f, "ai_voice_attempts_at", 30, s(f, "now")) + 1, 3,',
    );
    lineHas(
      "app/evaluator-kit.ts",
      24,
      "Date.parse(now) - Date.parse(t) < days * 86_400_000 && Date.parse(t) <= Date.parse(now)",
    );
    // The state's cap (ops.ts:497-500): Massachusetts 2, a debt collector 7, the policy 5.
    lineHas(
      "domain/early-intervention/ops.ts",
      499,
      'const cap = ov.includes("ma_940_cmr_7") ? 2 : i.debt_collector ? 7 : 5;',
    );
    // The bankruptcy disclaimer's window (contacts/derive.ts `disclaimer`) is the rubric's.
    const derive = readFileSync(here("../contacts/derive.ts"), "utf8");
    expect(derive).toContain(
      "!(bk.chapter === 13 && bk.discharged_on !== null && on >= bk.discharged_on)",
    );
    // The restated window counter agrees with the evaluator kit's on its edges.
    const now = "2026-12-21T17:00:00.000Z";
    expect(
      within(
        ["2026-12-14T17:00:00.000Z", "2026-12-14T17:01:00.000Z", now, "2026-12-21T17:01:00.000Z"],
        7,
        now,
      ),
    ).toBe(2);
    // The threat phrases are the threat words, read on a normalized line.
    for (const p of THREAT_PHRASES) expect(threatens(`and then ${p} for sure`), p).toBe(true);
    expect(threatens("we will look at the arrears")).toBe(false);
    expect(threatens("a wage garnishment")).toBe(false);
  });

  it("holds its templates to the copy library, parsed the way the servicing app parses it", () => {
    const channels = servicing("runtime/borrower/channels.ts");
    expect(channels[93]).toContain('"docs/ux/12-message-copy-library.md"');
    expect(channels[103]).toContain(`const m = ${COPY_LINE.toString()}.exec(line);`);
    const library = new Map<string, string>();
    for (const line of servicingFile("docs/ux/12-message-copy-library.md").split("\n")) {
      const m = COPY_LINE.exec(line);
      if (m && !library.has(m[1]!)) library.set(m[1]!, m[2]!);
    }
    for (const t of CALL_TEMPLATES) expect(library.get(t.key), t.key).toBe(t.text);
  });

  it("reads the spec's guardrails, its evaluation suite and the go-live gate where it cites them", () => {
    const spec = servicingFile(
      "spec/sections/11-early-intervention-collections/11-1-live-contact.md",
    ).split("\n");
    expect(spec[157]).toContain("no threat of action not actually intended/lawful (§1006.18(c))");
    expect(spec[157]).toContain("no negotiation of modification terms — only intake and referral");
    expect(spec[157]).toContain("no more than one voicemail per number per 7 days (policy)");
    expect(spec[157]).toContain(
      "pre_dial_checks{consent_id, line_type, tz_window, regf_count_before, landline_ai_30d, cease_flags, bk_flag, attorney_flag, scra_flag, pre_sale_gate}",
    );
    expect(spec[55]).toContain(
      "disclosure compliance 100 %, QRPC capture accuracy, prohibited-statement detection, quiet-hour/frequency guard tests",
    );
    expect(spec[53]).toContain(
      "**Legal opinion + partner sign-off** on AI voice as §1024.39(a) live contact",
    );
    expect(spec[147]).toContain("I'm an automated assistant for Supermortgage…");
    expect(spec.join("\n")).toContain(
      "**SCRA active duty**: cadence continues but scripts add the military-indulgence path",
    );
  });

  it("finds nothing on the contact center's calls as they were said, its dialer's window and caps included", () => {
    let n = 0;
    let dialed = 0;
    const problems: string[] = [];
    for (const loan of center.loans)
      for (const c of callsOf(loan)) {
        if (!reviewable(c)) continue;
        n++;
        if (c.direction === "outbound") dialed++;
        const r = reviewContactCall(center, book, c.id).said;
        for (const f of r.findings)
          problems.push(`${c.id} ${f.item}@${f.line ?? "-"}: ${f.detail}`);
        if (r.note && !r.note.matches)
          problems.push(`${c.id} note: ${r.note.contradictions.join(", ")}`);
      }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(n).toBeGreaterThan(400);
    expect(dialed).toBeGreaterThan(100);
  }, 60_000);

  it("finds each of the contact center's defects where it was planted, where the record can show it", () => {
    const ITEM: Record<ContactDefectId, RubricItem | null> = {
      "C-01": "identity",
      "C-02": "bankruptcy_collection",
      "C-03": "credit_misstatement",
      "C-04": "complaint_not_logged",
      "C-05": "wrong_amount",
      "C-06": "collection_disclosure",
      "C-07": "recording_disclosure",
      "C-08": null,
    };
    for (const id of Object.keys(CONTACT_DEFECTS) as ContactDefectId[]) {
      const res = plantContactDefects(center, book, [{ id, rate: 0.5 }]);
      let found = 0;
      let total = 0;
      const unexplained: string[] = [];
      for (const l of res.labels.filter((x) => x.root_cause)) {
        const cid =
          id === "C-08"
            ? res.defective.loans.flatMap((x) => x.notes).find((x) => x.id === l.row)!.contact_id!
            : l.row;
        const c = res.defective.loans.flatMap((x) => x.contacts).find((x) => x.id === cid)!;
        if (!reviewable(c, res.defective)) continue;
        total++;
        const r = reviewContactCall(res.defective, book, cid).said;
        const ok =
          ITEM[id] === null
            ? r.note !== null && !r.note.matches
            : r.findings.some(
                (f) =>
                  f.item === ITEM[id] && f.line === (l.planted_value === null ? null : l.turn! + 1),
              );
        if (ok) found++;
        // A wrong amount the check cannot see: its digit-runs are sources already (the P&I alone, last year's payment, a transposition).
        else if (id !== "C-05" && id !== "C-08") unexplained.push(`${cid}: ${l.planted_value}`);
        // Nothing else but C-02's missing disclaimer.
        for (const f of r.findings)
          if (f.item !== ITEM[id] && !(id === "C-02" && f.item === "collection_disclosure"))
            unexplained.push(`${cid}: ${f.item}@${f.line ?? "-"}`);
      }
      expect(unexplained.slice(0, 10), id).toEqual([]);
      expect(total, id).toBeGreaterThan(2);
      expect(found / total, id).toBeGreaterThan(0.8);
    }
  }, 120_000);

  it("reads the dialer's facts as the servicing app's gates do, on their edges", () => {
    const base: PreDialFacts = {
      dial_at: "2026-12-21T17:00:00.000Z",
      mode: "human_voice",
      time_zones: ["America/New_York"],
      line_type: "mobile",
      tcpa_voice_consent_active: false,
      written_consent: false,
      ai_voice_attempts_at: [],
      fdcpa_debt_collector: false,
      state: "NY",
      counted_call_attempts_at: [],
      voicemails_to_number_7d: 0,
      cease_active: false,
      written_cease: false,
      bk_active: false,
      attorney_represented: false,
    };
    const fails = (over: Partial<PreDialFacts>) =>
      failedPreDialChecks({ ...base, ...over }).map((x) => x.check);
    // A person dialing needs no consent; an AI voice does, and on a landline counts against three in 30 days.
    expect(fails({})).toEqual([]);
    expect(fails({ mode: "ai_voice" })).toEqual(["consent"]);
    const landline = [
      "2026-11-21T17:00:01.000Z",
      "2026-12-01T17:00:00.000Z",
      "2026-12-11T17:00:00.000Z",
    ];
    expect(
      fails({ mode: "ai_voice", line_type: "landline", ai_voice_attempts_at: landline }),
    ).toEqual(["line_type"]);
    expect(
      fails({
        mode: "ai_voice",
        line_type: "landline",
        ai_voice_attempts_at: ["2026-11-21T17:00:00.000Z", ...landline.slice(1)],
      }),
    ).toEqual([]);
    expect(
      fails({
        mode: "ai_voice",
        line_type: "landline",
        written_consent: true,
        ai_voice_attempts_at: landline,
      }),
    ).toEqual([]);
    // 08:00 is refused and 20:30 is not (11.1-T12; evaluators.ts:257); every candidate zone must pass.
    expect(fails({ dial_at: "2026-12-21T13:00:00.000Z" })).toEqual(["time_zone"]);
    expect(fails({ dial_at: "2026-12-22T01:30:00.000Z" })).toEqual([]);
    expect(fails({ dial_at: "2026-12-22T01:31:00.000Z" })).toEqual(["time_zone"]);
    expect(
      fails({
        dial_at: "2026-12-21T16:00:00.000Z",
        time_zones: ["America/New_York", "America/Los_Angeles"],
      }),
    ).toEqual(["time_zone"]);
    // The cap: 5 by policy, 2 in Massachusetts, 7 for a debt collector.
    const calls = (n: number) =>
      Array.from(
        { length: n },
        (_, k) => `2026-12-${String(15 + k).padStart(2, "0")}T15:00:00.000Z`,
      );
    expect(fails({ counted_call_attempts_at: calls(4) })).toEqual([]);
    expect(fails({ counted_call_attempts_at: calls(5) })).toEqual(["regf_count"]);
    expect(fails({ state: "MA", counted_call_attempts_at: calls(2) })).toEqual(["regf_count"]);
    expect(
      fails({ fdcpa_debt_collector: true, state: "MA", counted_call_attempts_at: calls(6) }),
    ).toEqual([]);
    expect(fails({ fdcpa_debt_collector: true, counted_call_attempts_at: calls(7) })).toEqual([
      "regf_count",
    ]);
    expect(fails({ cease_active: true, bk_active: true, attorney_represented: true })).toEqual([
      "cease",
      "bankruptcy",
      "attorney",
    ]);
  });

  it("reads a phrase as whole words, whatever the recognizer did to case and punctuation", () => {
    expect(normalizeLine("Don't worry, this WON'T hurt your credit!")).toBe(
      "don't worry this won't hurt your credit",
    );
    expect(
      says(
        "so i'll add the past-due amount to the end of it",
        "add the past due amount to the end",
      ),
    ).toBe(true);
    expect(says("it's not an attempt to collect a debt", "attempt to collect a debt")).toBe(true);
    expect(says("the payment options are", "payment deferral")).toBe(false);
    expect(says("I'm frustrated", "frustrated with")).toBe(false);
  });
});

describe("call-qa", () => {
  it("pins what a model is told, and states each rule the way the rubric applies it", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // CALL_QA_ENVIRONMENT_VERSION with this pin.
    expect(CALL_QA_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "call-qa",
        "rulebook_sha256": "466daf75b5ddb9b747056814e6bc66740d093e507d2f31efb9cb553b649f1ac5",
        "tools_sha256": "b183a3f242ecfd6dfa18e20426c0def3fca41bfcc7cc364a0d411ddbc005dbd6",
        "version": "1.0.0",
      }
    `);
    const stated = [
      "identity: when call.identity_verified is not true, every agent line that says a dollar amount is a finding on its line. An automatic fail.",
      'ai_disclosure: when call.voice is "ai", one of the first 3 agent lines must say "automated assistant".',
      `recording_disclosure: when call.direction is "outbound" and call.outcome is "conversation", some agent line must say ${phraseList(RECORDING_PHRASES)}.`,
      'collection_disclosure: when call.outcome is "conversation" and call.with is not "attorney", one disclosure is due:',
      "it is not a Chapter 13 case with a discharged_on on or before the call's day.",
      "otherwise the mini-Miranda, when call.debt_collector is true or record.past_due is not null.",
      "predial_time_zone: in some zone of time_zones, the local time of dial_at is not after 08:00 or is after 20:30",
      'The cap is 7 when fdcpa_debt_collector is true; otherwise 2 when state is "MA", and 5 elsewhere.',
      `negotiation: an agent line that says ${phraseList(NEGOTIATION_PHRASES)}.`,
      `bankruptcy_collection: when the record shows a bankruptcy case (as for the disclaimer above, whatever the outcome), an agent line that says ${phraseList(COLLECTION_PHRASES)}. An automatic fail.`,
      `credit_misstatement: an agent line that says ${phraseList(CREDIT_MISSTATEMENT_PHRASES)}. An automatic fail.`,
      `complaint_not_logged: when call.complaint_logged is false, a caller line that says ${phraseList(COMPLAINT_PHRASES)}. An automatic fail.`,
      "A run on an agent line with no source is a finding on that line: wrong_amount when the run is part of a dollar amount on the line (an automatic fail), provenance when it is not.",
      `fails_outright is true exactly when some finding is ${AUTOMATIC_FAILS.slice(0, -1).join(", ")} or wrong_amount.`,
      'Otherwise split note.text at the first " | PREV: "',
    ];
    expect(stated.filter((rule) => !CALL_QA_RULEBOOK.includes(rule))).toEqual([]);
    const at = stated.map((rule) => CALL_QA_RULEBOOK.indexOf(rule));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // Every item is in the rulebook, by name, and every template and option.
    for (const item of RUBRIC_ITEMS)
      expect(CALL_QA_RULEBOOK, item).toMatch(new RegExp(`\\b${item}\\b`));
    for (const t of CALL_TEMPLATES) expect(CALL_QA_RULEBOOK).toContain(`- ${t.key}: "${t.text}"`);
    for (const o of OPTIONS)
      expect(CALL_QA_RULEBOOK).toContain(`${o} is named by ${phraseList(OPTION_PHRASES[o])}`);
    // An item takes a line exactly when the rulebook finds it on one.
    for (const item of LINE_ITEMS) expect(RUBRIC_ITEMS).toContain(item);
  });

  describe("gives the spec's own cases", () => {
    const one = (prefix: string) => keys(expectedCallQa(specTask(prefix)));
    it("11.1-T12: 20:45 ET and 08:00 PT refused, 12:00 ET permitted", () => {
      expect(one("11.1-T12: property in New York")).toEqual(["predial_time_zone@-"]);
      expect(one("11.1-T12: dialed at 11:00 ET")).toEqual(["predial_time_zone@-"]);
      expect(one("11.1-T12: dialed at 12:00 ET")).toEqual([]);
      const t = specTask("11.1-T12: property in New York");
      expect(
        JSON.parse(
          executeCallQaTool(
            "local_time",
            { instant: t.pre_dial!.dial_at, time_zone: "America/New_York" },
            t,
          ),
        ),
      ).toEqual({ date: "2026-12-21", time: "20:45" });
      expect(
        JSON.parse(
          executeCallQaTool(
            "local_time",
            { instant: t.pre_dial!.dial_at, time_zone: "America/Los_Angeles" },
            t,
          ),
        ),
      ).toEqual({ date: "2026-12-21", time: "17:45" });
    });
    it("11.1-T10 and T21: no consent on a mobile, a fourth landline call in 30 days; a third is permitted", () => {
      expect(one("11.1-T10")).toEqual(["predial_consent@-"]);
      expect(one("11.1-T21: a landline")).toEqual(["predial_line_type@-"]);
      expect(one("11.1-T21: the same landline")).toEqual([]);
    });
    it("11.1-T13 and T7: an eighth counted call in 7 days; a dial into a Chapter 13 case", () => {
      expect(one("11.1-T13")).toEqual(["predial_regf_count@-"]);
      expect(one("11.1-T7")).toEqual(["predial_bankruptcy@-"]);
    });
    it("11.1 rule 13: $4,165.00 is the ledger's; $4,082.50, worked out, fails outright", () => {
      const ok = expectedCallQa(specTask("11.1 rule 13: past due"));
      expect(keys(ok)).toEqual([]);
      expect(ok.note).toEqual({ matches: true, contradictions: [] });
      expect(ok.options_told).toEqual([
        { option: "repayment_plan", line: 11 },
        { option: "forbearance", line: 11 },
      ]);
      const bad = expectedCallQa(specTask("11.1 rule 13: the AI never"));
      expect(keys(bad)).toEqual(["wrong_amount@9"]);
      expect(bad.fails_outright).toBe(true);
    });
    it("11.1 design item 1, Q3, the guardrails and T23: the disclosure, a second voicemail, a threat, terms offered, no recording notice", () => {
      expect(one("11.1 design item 1")).toEqual(["ai_disclosure@-"]);
      expect(one("11.1-Q3")).toEqual(["voicemail@1"]);
      expect(one("11.1 guardrail (§1006.18(c))")).toEqual(["threat@12"]);
      expect(one("11.1 guardrail: no negotiation")).toEqual(["negotiation@12"]);
      expect(one("11.1-T23")).toEqual(["recording_disclosure@-"]);
    });
    it("the edge cases: a written cease, counsel", () => {
      expect(one("11.1 edge cases: an FDCPA cease")).toEqual(["predial_cease@-"]);
      expect(one("11.1 edge cases (§1006.6(b)(2))")).toEqual(["predial_attorney@-"]);
    });
  });

  it("fails an answer one line off on exactly that field, and charges for a finding that is not there", () => {
    const t = specTask("11.1 guardrail (§1006.18(c))");
    const want = expectedCallQa(t);
    expect(gradeCallQaAgainst(want, want).pass).toBe(true);
    const off = gradeCallQaAgainst(want, { ...want, findings: [{ item: "threat", line: 11 }] });
    expect(off.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual(["finding.threat"]);
    const extra = gradeCallQaAgainst(want, {
      ...want,
      findings: [...want.findings, { item: "recording_disclosure", line: null }],
    });
    expect(extra.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual([
      "finding.recording_disclosure",
    ]);
    expect(extra.score).toBeLessThan(1);
    // Nothing answered: every field missed; "clean" on a clean call passes.
    expect(gradeCallQaAgainst(want, null).score).toBe(0);
    const clean = specTask("11.1-T12: dialed at 12:00 ET");
    expect(
      gradeCallQaAgainst(expectedCallQa(clean), {
        findings: [],
        fails_outright: false,
        note: { matches: true, contradictions: [] },
        options_told: expectedCallQa(clean).options_told,
      }).pass,
    ).toBe(true);
    // A contradiction is compared without its dollar sign, commas or case.
    const note = { ...want, note: { matches: false, contradictions: ["$1,234.56", "current"] } };
    expect(
      gradeCallQaAgainst(note, {
        ...note,
        note: { matches: false, contradictions: ["1234.56", "CURRENT"] },
      }).pass,
    ).toBe(true);
  });

  it("reads a submission strictly, as the schema says, and bounces one that does not hang together", () => {
    const ok = {
      findings: [{ item: "threat", line: 3 }],
      fails_outright: false,
      note: null,
      options_told: [],
    };
    expect(parseCallQaSubmission(ok).ok).toBe(true);
    const bounce = (over: Record<string, unknown>, why: RegExp) => {
      const r = parseCallQaSubmission({ ...ok, ...over });
      expect(r.ok, JSON.stringify(over)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(why);
    };
    bounce({ findings: [{ item: "threat" }] }, /found on a line/);
    bounce({ findings: [{ item: "predial_cease", line: 4 }] }, /found on no line/);
    bounce({ findings: [{ item: "rudeness", line: 4 }] }, /no rubric item/);
    bounce(
      { findings: [{ item: "wrong_amount", line: 4 }] },
      /fails_outright is false, but wrong_amount/,
    );
    bounce({ fails_outright: true }, /no finding is an automatic fail/);
    bounce({ note: { matches: true, contradictions: ["$1.00"] } }, /matches exactly when/);
    bounce({ options_told: [{ option: "loan_mod", line: 2 }] }, /no option/);
    bounce(
      {
        options_told: [
          { option: "forbearance", line: 2 },
          { option: "forbearance", line: 5 },
        ],
      },
      /twice/,
    );
    bounce({ verdict: "fail" }, /unknown fields/);
    // A finding listed twice is one finding.
    const twice = parseCallQaSubmission({
      ...ok,
      findings: [
        { item: "threat", line: 3 },
        { item: "threat", line: 3 },
      ],
    });
    expect(twice.ok && twice.answer.findings).toHaveLength(1);
  });

  describe("scores an answer that reviews nothing for what it did", () => {
    const held = heldTasks().map(expectedCallQa);
    const scored = (answer: (want: CallQaAnswer) => CallQaAnswer) => {
      let passed = 0;
      let sum = 0;
      for (const want of held) {
        const g = gradeCallQaAgainst(want, answer(want));
        if (g.pass) passed++;
        sum += g.score;
      }
      return { passed, mean: sum / held.length };
    };
    const clean = held.filter((a) => a.findings.length === 0).length;
    it("an answer that says nothing scores about a half, passing only clean calls with no note and no option", () => {
      const s = scored(() => ({
        findings: [],
        fails_outright: false,
        note: null,
        options_told: [],
      }));
      expect(s.passed).toBeLessThan(held.length * 0.1);
      expect(s.mean).toBeGreaterThan(0.45);
      expect(s.mean).toBeLessThan(0.55);
    });
    it("calling every call clean, the note and options right: about 0.76, passing the clean calls alone", () => {
      const s = scored((w) => ({ ...w, findings: [], fails_outright: false }));
      expect(s.passed).toBe(clean);
      expect(clean / held.length).toBeGreaterThan(0.25);
      expect(s.mean).toBeGreaterThan(0.7);
      expect(s.mean).toBeLessThan(0.82);
    });
    it("every finding named but on no line: about 0.91, failing every call with a line to find", () => {
      const s = scored((w) => ({
        ...w,
        findings: w.findings.map((f) => ({ item: f.item, line: null })),
      }));
      expect(s.passed).toBe(held.filter((a) => !a.findings.some((f) => f.line !== null)).length);
      expect(s.mean).toBeGreaterThan(0.85);
    });
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const drawn = heldout();
    const r = await solveAll([...SPEC, ...drawn.map((x) => x.task)]);
    expect(r.misses).toEqual([]);
    // One turn of reading, one to submit: inside the episode's 80 turns and 160 calls.
    expect(r.turns).toBeLessThanOrEqual(2);
    expect(r.calls).toBeLessThan(40);
    // Every draw kept took fewer redraws than the guard's 60.
    expect(Math.max(...drawn.map((x) => x.attempts))).toBeLessThan(40);
  }, 180_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generateCallQaSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
  }, 180_000);

  it("holds the reference, the rulebook as code, to the grader without the episode loop", () => {
    const misses = generateCallQaSuite("train", 23, 90).flatMap(byRulesMisses);
    expect(misses).toEqual([]);
  }, 120_000);

  it("reads the record on another day as the task's own: the call's day is the task's record", () => {
    for (const t of generateCallQaSuite("train", 5, 60)) {
      expect(toJsonLine(recordFor(t, t.call.on)), t.id).toBe(toJsonLine(t.record));
      if (t.note?.copied_from)
        expect(toJsonLine(recordFor(t, t.note.copied_from.on))).toBe(toJsonLine(t.copied_record));
      expect(() => recordFor(t, "2099-01-01")).toThrow(/on or before the call's day/);
    }
    const t = generateCallQaTask("train", 5, 0);
    const search = JSON.parse(
      executeCallQaTool("search_transcript", { phrases: ["thank you"] }, t),
    ) as {
      matches: { phrase: string; lines: { line: number }[] }[];
    };
    expect(
      search.matches[0]!.lines.every((l) => says(t.transcript[l.line - 1]!.text, "thank you")),
    ).toBe(true);
    expect(() => executeCallQaTool("search_transcript", { phrases: ["x"] })).toThrow(
      /reads the task/,
    );
    expect(
      JSON.parse(
        executeCallQaTool("minutes_between", {
          from: "2026-12-21T17:00:00.000Z",
          to: "2026-12-14T17:00:00.000Z",
        }),
      ),
    ).toEqual({ minutes: -10080 });
    expect(() =>
      executeCallQaTool("local_time", {
        instant: "2026-12-21T17:00:00.000Z",
        time_zone: "Mars/Olympus",
      }),
    ).toThrow(/no time zone/);
    expect(() => executeCallQaTool("verdict", {})).toThrow(/no tool named/);
  }, 60_000);

  it("keeps a draw only when it is fair to grade", () => {
    const review = (
      findings: string[],
      note: { matches: boolean; contradictions: string[] } | null = null,
    ) => ({
      findings: findings.map((k) => {
        const [item, line] = k.split("@");
        return { item: item as RubricItem, line: line === "-" ? null : Number(line), detail: "" };
      }),
      fails_outright: false,
      note,
      options_told: [],
    });
    const clean = { said: review([]), heard: review([]) };
    expect(judge(clean, null)).toEqual([]);
    expect(
      judge(
        { said: review(["predial_time_zone@-"]), heard: review(["predial_time_zone@-"]) },
        null,
      )[0],
    ).toMatch(/clean call draws/);
    expect(judge({ said: review([]), heard: review(["provenance@4"]) }, null)[0]).toMatch(
      /reads differently/,
    );
    const plant = (said: string[], heard = said, symptoms: RubricItem[] = []) =>
      judge(clean, {
        said: review(said),
        heard: review(heard),
        root: { item: "threat", line: 7 },
        symptoms,
      });
    expect(plant(["threat@7"])).toEqual([]);
    expect(plant(["threat@8"])[0]).toMatch(/not found/);
    expect(plant(["threat@7", "provenance@7"])[0]).toMatch(/does not name/);
    expect(plant(["threat@7", "provenance@7"], undefined, ["provenance"])).toEqual([]);
    expect(plant(["threat@7"], ["threat@7", "wrong_amount@3"])[0]).toMatch(/reads differently/);
  });

  it("draws no clean call asking a borrower in a bankruptcy case when they will pay", () => {
    // Life 1.1.0's book for train/3/1062 put an inbound call to arrange a payment in the notice's own month, after
    // the notice, and the agent asked when the borrower could pay: collection language in the case. The contact
    // center now draws the case's reasons from the notice's day and asks no such question in a case.
    const { book: b, center: c } = rebuild(
      callQaTaskId("train", 3, 1062),
      {
        loans: 1,
        months: 30,
        events: [
          { kind: "missed_payment", loan: 0, month: 20 },
          { kind: "missed_payment", loan: 0, month: 21 },
        ],
      },
      { language: "en", bankruptcy: true },
    );
    const loan = c.loans[0]!;
    expect(loan.bankruptcy).not.toBeNull();
    const found = callsOf(loan)
      .filter(
        (x) =>
          !x.interpreter && x.purpose !== "welcome" && callPlan(c, b, x.id).recording === "stereo",
      )
      .flatMap((x) =>
        reviewContactCall(c, b, x.id).said.findings.map((f) => `${x.id} ${f.item}@${f.line}`),
      );
    expect(found).toEqual([]);
  }, 60_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump CALL_QA_ENVIRONMENT_VERSION, then the pin. The suite
    // is drawn from the life generator and the contact center: a change to either moves it too.
    expect(sha256(heldTasks().map(toJsonLine).join(""))).toMatchInlineSnapshot(
      `"697ad78d4a2a5bb26333ee9c257ff5a8e14e74ace9f2b934162c22ece6e2dc21"`,
    );
  }, 60_000);

  it("rebuilds a task from its coordinates, and never draws a held-out call into training", () => {
    expect(toJsonLine(generateCallQaTask("train", 7, 17))).toBe(
      toJsonLine(generateCallQaSuite("train", 7, 30)[17]),
    );
    const fp = (t: CallQaTask) => toJsonLine(callQaPayload(t));
    const held = new Set(heldTasks().map(fp));
    expect(generateCallQaSuite("train", 1, 300).filter((t) => held.has(fp(t)))).toEqual([]);
    expect(callQaTaskId("heldout", 1, 0)).toBe("call-qa/1.0.0/heldout/1/0");
  }, 120_000);

  describe("each edge, item and verdict turns up", () => {
    const train = generateCallQaSuite("train", 3, 420).map((t, i) => ({
      t,
      a: expectedCallQa(t),
      edge: callQaEdgeOf(i),
      i,
    }));
    const held = heldTasks().map(expectedCallQa);

    it("cycles through every edge, and every verdict above 15 %, here and held out", () => {
      expect(new Set(train.map((x) => x.edge))).toEqual(new Set(CALL_QA_EDGES));
      for (const v of ["clean", "findings", "fails outright"]) {
        expect(
          train.filter((x) => callQaVerdict(x.t) === v).length / train.length,
          v,
        ).toBeGreaterThan(0.15);
        expect(
          held.filter(
            (a) =>
              (a.fails_outright ? "fails outright" : a.findings.length ? "findings" : "clean") ===
              v,
          ).length / held.length,
          v,
        ).toBeGreaterThan(0.15);
      }
    });

    it("turns up every item, a note that contradicts, and every option, in training and held out", () => {
      for (const set of [train.map((x) => x.a), held]) {
        const items = new Set(set.flatMap((a) => a.findings.map((f) => f.item)));
        expect(RUBRIC_ITEMS.filter((i) => !items.has(i))).toEqual([]);
        expect(set.some((a) => a.note !== null && !a.note.matches)).toBe(true);
        expect(set.some((a) => a.note === null)).toBe(true);
        const told = new Set(set.flatMap((a) => a.options_told.map((o) => o.option)));
        for (const o of ["repayment_plan", "forbearance", "modification"] as const)
          expect(told.has(o), o).toBe(true);
      }
    });

    it("a clean edge is clean, and each planted edge is found where it was planted", () => {
      for (const x of train) {
        if (x.edge.startsWith("clean_")) {
          expect(keys(x.a), x.t.id).toEqual([]);
          expect(x.t.planted).toBeNull();
          continue;
        }
        expect(x.t.planted?.defect, x.t.id).toBe(x.edge);
        const want: Record<string, RubricItem | "note"> = {
          "C-01": "identity",
          "C-02": "bankruptcy_collection",
          "C-03": "credit_misstatement",
          "C-04": "complaint_not_logged",
          "C-05": "wrong_amount",
          "C-06": "collection_disclosure",
          "C-07": "recording_disclosure",
          "C-08": "note",
          "Q-01": "ai_disclosure",
          "Q-02": "predial_consent",
          "Q-03": "predial_line_type",
          "Q-04": "predial_time_zone",
          "Q-05": "predial_regf_count",
          "Q-06": "predial_cease",
          "Q-07": "predial_bankruptcy",
          "Q-08": "predial_attorney",
          "Q-09": "military",
          "Q-10": "threat",
          "Q-11": "negotiation",
          "Q-12": "voicemail",
          "Q-13": "verbatim",
          "Q-14": "provenance",
        };
        const w = want[x.edge]!;
        if (w === "note") expect(x.a.note?.matches, x.t.id).toBe(false);
        else
          expect(
            x.a.findings.map((f) => f.item),
            x.t.id,
          ).toContain(w);
      }
    });

    it("never runs a transcript's times backwards, a line written into the call included", () => {
      for (const { t } of train)
        for (let i = 1; i < t.transcript.length; i++)
          expect(t.transcript[i]!.at >= t.transcript[i - 1]!.at, `${t.id} line ${i + 1}`).toBe(
            true,
          );
    });

    it("takes each edge's arms in turn: the AI's two lines, the zone's two sides, the cap's two owners, the cease's two kinds", () => {
      const of = (edge: string) => train.filter((x) => x.edge === edge);
      for (const x of of("clean_ai"))
        expect(x.t.pre_dial!.line_type).toBe(callQaArmOf(x.i, 2) === 0 ? "mobile" : "landline");
      for (const x of of("Q-04")) {
        const zone = x.t.pre_dial!.time_zones[1]!;
        const t = JSON.parse(
          executeCallQaTool("local_time", { instant: x.t.pre_dial!.dial_at, time_zone: zone }, x.t),
        ) as { time: string };
        if (callQaArmOf(x.i, 2) === 0) expect(t.time <= "08:00", x.t.id).toBe(true);
        else expect(t.time > "20:30", x.t.id).toBe(true);
      }
      for (const x of of("Q-05"))
        expect(x.t.pre_dial!.fdcpa_debt_collector).toBe(callQaArmOf(x.i, 2) === 0);
      for (const x of of("Q-06"))
        expect(x.t.pre_dial!.written_cease).toBe(callQaArmOf(x.i, 2) === 1);
      for (const x of of("clean_dc")) expect(x.t.call.debt_collector).toBe(true);
      for (const x of of("clean_military")) expect(x.t.call.servicemember_active_duty).toBe(true);
      for (const x of [...of("clean_ai"), ...of("Q-01"), ...of("Q-02"), ...of("Q-03")])
        expect(x.t.call.voice).toBe("ai");
    });
  });

  it("names a verdict for every task, and a fail outright only for an automatic fail", () => {
    for (const t of [...SPEC, ...generateCallQaSuite("train", 9, 60)]) {
      const a = expectedCallQa(t);
      expect(a.fails_outright).toBe(a.findings.some((f) => AUTOMATIC_FAILS.includes(f.item)));
      expect(["clean", "findings", "fails outright"]).toContain(callQaVerdict(t));
    }
    // The verbatim check reads a template's words, a token standing for any.
    const r = reviewCall({
      ...expectedCallQaInput(specTask("11.1 rule 13: past due")),
      lines: [
        {
          line: 1,
          speaker: "agent",
          text: "Your payment due November 1st hasn't arrived — here are your options and your team.",
        },
      ],
    });
    expect(r.findings.filter((f) => f.item === "verbatim").map((f) => f.line)).toEqual([1]);
  });
});

/** A spec task as the rubric's input. */
function expectedCallQaInput(t: CallQaTask) {
  return {
    call: t.call,
    lines: [],
    record: t.record,
    pre_dial: t.pre_dial,
    note: null,
    copied_record: null,
  };
}
