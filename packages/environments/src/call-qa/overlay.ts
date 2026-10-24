/**
 * What call-qa writes into a contact-center call: the AI voice's
 * introduction, the servicemember script, and the defects the contact
 * center does not plant (a threat, an offer of modification terms, a copy-
 * library line read whole, an invented figure). Each is a turn replaced or
 * inserted, in the contact center's own phrase grammar, and each new turn
 * goes through the contact center's own speech recognizer; every other turn
 * is the call as the contact center wrote it, word for word.
 *
 * The words are ours, each a design choice: no public source gives an AI
 * servicer's introduction or a collector's threat. The introduction follows
 * the 11.1 design item 1 ("I'm an automated assistant for Supermortgage…").
 */

import { rngFor, type Rng } from "../rng.js";
import { expand, type Slots } from "../contacts/grammar.js";
import { recognize } from "../contacts/noise.js";
import type { Speaker, Turn } from "../contacts/types.js";
import type { EvalTemplate } from "../calls/index.js";

/** Whether the transcript came from the lower-case recognizer: no agent turn has a capital letter. */
export const lowerEngine = (turns: readonly Turn[]): boolean =>
  turns
    .filter((t) => t.speaker === "AGENT" && /[a-z]/i.test(t.text))
    .every((t) => t.text === t.text.toLowerCase());

const LABEL: Readonly<Record<Speaker, string>> = {
  AGENT: "Agent",
  AGENT_2: "Agent",
  CALLER: "Customer",
  INTERPRETER: "Interpreter",
  IVR: "IVR",
  SYSTEM: "",
};
const RATE = 2.6;

function heard(r: Rng, said: string, lower: boolean): { text: string; noise: Turn["noise"] } {
  const x = recognize(r, said, [], lower);
  return { text: x.text, noise: x.noise };
}

/** A turn's words replaced, its timing kept, the new words recognized from their own stream. */
export function replaceTurn(
  turns: readonly Turn[],
  i: number,
  said: string,
  tag: string,
  key: string,
  lower: boolean,
): Turn[] {
  const t = turns[i]!;
  const h = heard(rngFor(`${key}/asr`), said, lower);
  const out = [...turns];
  out[i] = { ...t, said, text: h.text, noise: h.noise, tag, defect: null };
  return out;
}

/**
 * A new turn before index `i`, in the gap after the turn before it. Where
 * the two turns around it overlap (crosstalk), it starts no later than the
 * turn after it, so the transcript's times never run backwards.
 */
export function insertTurn(
  turns: readonly Turn[],
  i: number,
  speaker: Speaker,
  said: string,
  tag: string,
  key: string,
  lower: boolean,
): Turn[] {
  const before = turns[i - 1];
  const after = turns[i];
  const gap = before ? before.end_s + 0.4 : 0;
  // Rounded to a tenth, then held between the starts of the turns around it.
  const start = Math.min(
    Math.max(Math.round(gap * 10) / 10, before?.start_s ?? 0),
    after?.start_s ?? Infinity,
  );
  const want = start + said.split(/\s+/).length / RATE;
  const end = after ? Math.max(start + 0.5, Math.min(want, after.start_s - 0.2)) : want;
  const h = heard(rngFor(`${key}/asr`), said, lower);
  const turn: Turn = {
    speaker,
    label: LABEL[speaker],
    start_s: start,
    end_s: Math.round(end * 10) / 10,
    said,
    text: h.text,
    noise: h.noise,
    tag,
    facts: [],
    defect: null,
  };
  return [...turns.slice(0, i), turn, ...turns.slice(i)];
}

/** The AI voice's introduction, with the disclosure, or without it. */
export function aiIntroduction(r: Rng, s: Slots, disclose: boolean): string {
  return disclose
    ? expand(
        r,
        "[Hi|Hello] {b_first}, I'm an automated assistant calling for {servicer}[, your mortgage servicer|]. [You can ask for a person at any time.|If you'd like to talk to a person, just say so.]",
        s,
      )
    : expand(r, "[Hi|Hello] {b_first}, this is {servicer} calling[ about your mortgage|].", s);
}

/** The script an active-duty servicemember's call carries (11.1, "SCRA active duty"). */
export function militaryScript(r: Rng, s: Slots): string {
  return expand(
    r,
    "[Before we go on,|One more thing first,] [our records show|I see] you're on active military duty, so you have protections under the Servicemembers Civil Relief Act[, and we have assistance for servicemembers|]. [I'll send you the details.|I can send you information on that.]",
    s,
  );
}

/** A threat in the servicing app's own words (section11.ts:57). */
export function threatLine(r: Rng, s: Slots): string {
  return expand(
    r,
    "[If we don't get a payment|If this isn't taken care of|If you can't pay], [we will foreclose next week|legal action will be taken|we will sue|we can garnish your wages].",
    s,
  );
}

/** Modification terms offered on the call: rate, term or balance, no figure. */
export function negotiationLine(r: Rng, s: Slots): string {
  return expand(
    r,
    "[Honestly,|Look,] I can [set you up with|get you] a modification today: [I'll lower your rate|we'll drop your rate|I can reduce your rate] and [extend your term|add the past-due amount to the end of the loan], so your payment [goes down|comes down].",
    s,
  );
}

/** A copy-library line, its tokens filled from the record's words. */
export function templateLine(t: EvalTemplate, s: Slots): string {
  return t.text.replace(/\{\{date\}\}/g, s["oldest_due"] ?? s["next_due"] ?? "");
}

/** An invented figure: a processing time the record does not hold. */
export function inventedLine(r: Rng, days: number): string {
  return expand(
    r,
    `[That usually takes|It normally takes] about ${days} business days to [update|show up on the account].`,
  );
}
