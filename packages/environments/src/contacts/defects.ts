/**
 * Call and note defects, planted and labeled, for a call-QA environment.
 *
 * Each is something a QA team fails a call for automatically (plan section 4;
 * the servicing app's collections spec, 11-1-live-contact.md, "Agents and
 * tools", for the guardrails behind them): an account disclosed to someone
 * not verified, collection language during a bankruptcy stay, "this won't
 * hurt your credit", a complaint voiced and not logged, a wrong amount, a
 * missing mini-Miranda, a missing recording disclosure, and a note that
 * contradicts the record. None is in docs/synthetic-data-defects.md, which
 * catalogs data defects; these are conduct, numbered C-01 to C-08.
 *
 * A defect is planted where it enters: in one turn of one call, written by
 * the writer and then changed, or in one note. The call is otherwise the call
 * the clean book holds, word for word (the replacement draws from a stream of
 * its own), so the label points at one turn. Its label is the life
 * generator's (`DefectLabel`, life/defects.ts) with the turn added: the loan,
 * the defect, the table and field, the row, the true value, the planted
 * value, and what a servicer should do. A complaint not logged also leaves
 * its log entry missing, labeled as a symptom.
 */

import type { DefectLabel } from "../life/defects.js";
import type { Rng } from "../rng.js";
import { money } from "./format.js";
import { expand, type Slots } from "./grammar.js";
import { factNumbers } from "./record.js";
import { numberTokens } from "./check.js";
import type { CallPlan } from "./plan.js";
import type { ContactRecord } from "./types.js";
import type { DraftTurn } from "./writer.js";

export type ContactDefectId = "C-01" | "C-02" | "C-03" | "C-04" | "C-05" | "C-06" | "C-07" | "C-08";

export interface ContactDefect {
  readonly id: ContactDefectId;
  readonly title: string;
  /** Where the root cause lives: a transcript's turns, the contact row, or a note. */
  readonly table: "contact_transcripts" | "contacts" | "contact_notes";
  readonly field: string;
  /** The turn the defect acts on, by its tag. */
  readonly tag: string | null;
  /** Whether the defect can be planted on this contact, from its row alone. */
  eligible(c: ContactRecord): boolean;
  readonly handling: string;
}

const conversation = (c: ContactRecord) => c.mode === "call" && c.outcome === "conversation";

export const CONTACT_DEFECTS: Readonly<Record<ContactDefectId, ContactDefect>> = {
  "C-01": {
    id: "C-01",
    title: "Account information disclosed to a caller who was not verified",
    table: "contact_transcripts",
    field: "said",
    tag: "unverified_refusal",
    eligible: (c) =>
      c.mode === "call" &&
      c.transcript &&
      (c.outcome === "answered_unverified" || c.outcome === "wrong_number"),
    handling:
      "Fail the call: the agent disclosed the loan's details to someone who had not passed the identity checks " +
      "(Gramm-Leach-Bliley privacy; Reg F §1006.6(d)(1) on a debt-collector loan; 11.1 rule 3). Log a privacy incident, " +
      "coach the agent, and assess whether the borrower must be notified.",
  },
  "C-02": {
    id: "C-02",
    title: "Collection language during a bankruptcy stay",
    table: "contact_transcripts",
    field: "said",
    tag: "bk_disclaimer",
    eligible: (c) => conversation(c) && c.disclosures_marked.bankruptcy,
    handling:
      "Fail the call: the automatic stay (11 U.S.C. §362(a)(6)) bars any act to collect while the case is open, and after a " +
      "discharge the debt is not the borrower's personal liability. Escalate to the bankruptcy team and counsel; the call " +
      "should have carried the informational-only disclaimer and no demand for payment.",
  },
  "C-03": {
    id: "C-03",
    title: '"This won\'t hurt your credit" said on a delinquent loan',
    table: "contact_transcripts",
    field: "said",
    tag: "credit_answer",
    eligible: (c) => conversation(c),
    handling:
      "Fail the call: the statement is false for a loan furnished as 30 or more days past due (Metro 2) and is a deceptive " +
      "representation (Reg F §1006.18; UDAAP). Correct it with the borrower in writing and coach the agent.",
  },
  "C-04": {
    id: "C-04",
    title: "A complaint voiced on a call and not logged",
    table: "contacts",
    field: "complaint_logged",
    tag: "complaint_ack",
    eligible: (c) => conversation(c) && c.complaint_voiced,
    handling:
      "Log the complaint as of the call's date, route it to the complaint team for a response, and review it for a notice " +
      "of error (§1024.35) if it asserts one. A complaint voiced and not logged fails the call.",
  },
  "C-05": {
    id: "C-05",
    title: "A wrong amount quoted to the borrower",
    table: "contact_transcripts",
    field: "said",
    tag: "quote:",
    eligible: (c) => conversation(c),
    handling:
      "Fail the call: the amount the agent quoted is not the record's. Call the borrower back with the right figure, in " +
      "writing if a payment depends on it, and check whether a payment was short or a fee followed because of it.",
  },
  "C-06": {
    id: "C-06",
    title: "The mini-Miranda not given on a call that needed it",
    table: "contact_transcripts",
    field: "said",
    tag: "mini_miranda",
    eligible: (c) => conversation(c) && c.disclosures_marked.fdcpa,
    handling:
      "Fail the call: on a debt-collector loan §1006.18(e) requires the disclosure in every communication, and the servicer's " +
      "policy gives it on every collection call. The row marks it given; the recording does not have it. Coach the agent " +
      "and correct the row.",
  },
  "C-07": {
    id: "C-07",
    title: "The recording disclosure not given on an outbound call",
    table: "contact_transcripts",
    field: "said",
    tag: "recording_disclosure",
    eligible: (c) =>
      c.mode === "call" && c.direction === "outbound" && c.outcome === "conversation",
    handling:
      "Fail the call: the agent did not say the call was recorded. In an all-party-consent state the recording itself may " +
      "be unlawful; refer to compliance, and coach the agent.",
  },
  "C-08": {
    id: "C-08",
    title: "A note that contradicts the record",
    table: "contact_notes",
    field: "text",
    tag: null,
    eligible: (c) => c.mode === "call" && c.transcript,
    handling:
      "Correct the note against the record (an addendum, never an edit of the original), and check whether anything was " +
      "done on the strength of the wrong figure.",
  },
};

export function contactDefectById(id: string): ContactDefect {
  const d = (CONTACT_DEFECTS as Record<string, ContactDefect>)[id];
  if (!d)
    throw new RangeError(
      `no contact defect ${id}; there are ${Object.keys(CONTACT_DEFECTS).join(", ")}`,
    );
  return d;
}

export interface ContactDefectLabel extends DefectLabel {
  /** The transcript turn the defect is in (or, for a missing disclosure, the turn it should have preceded), or null. */
  readonly turn: number | null;
}

/** What a planted turn changes, for its label. */
export interface TurnPlant {
  readonly turns: DraftTurn[];
  /** The planted turn's index in the new list, or the index the missing turn would have had. */
  readonly at: number;
  readonly true_value: string | null;
  readonly planted_value: string | null;
}

/** A wrong amount near the true one: digits transposed, the P&I alone, or last year's payment. */
export function wrongAmount(r: Rng, cents: bigint, plan: CallPlan): bigint {
  const f = plan.facts;
  const options: bigint[] = [];
  const s = (cents / 100n).toString();
  if (s.length >= 2) {
    const i = r.int(0, s.length - 2);
    const t = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
    const v = BigInt(t) * 100n + (cents % 100n);
    if (v !== cents && v > 0n) options.push(v);
  }
  if (f.next && cents === f.next.amount && f.next.escrow > 0n) options.push(f.next.pi);
  if (f.analysis && cents === f.analysis.new_total && f.analysis.old_total !== cents)
    options.push(f.analysis.old_total);
  options.push(cents + BigInt(r.int(1, 9)) * 1000n + BigInt(r.int(0, 99)));
  return r.pick(options);
}

const relayOf = (turns: readonly DraftTurn[], i: number): number =>
  turns[i + 1] &&
  turns[i + 1]!.speaker === "INTERPRETER" &&
  turns[i + 1]!.tag === `${turns[i]!.tag}:relay`
    ? i + 1
    : -1;

/** Plant a defect in a call's turns, or return null when the call has no turn it can go in. */
export function plantInTurns(
  id: ContactDefectId,
  r: Rng,
  plan: CallPlan,
  slots: Slots,
  turns: readonly DraftTurn[],
): TurnPlant | null {
  const def = CONTACT_DEFECTS[id];
  const t = [...turns];
  const replace = (i: number, said: string, es: string | null): TurnPlant => {
    const old = t[i]!;
    t[i] = { ...old, said, pii: [] };
    const k = relayOf(turns, i);
    if (k >= 0 && es !== null) t[k] = { ...t[k]!, said: es, pii: [] };
    return { turns: t, at: i, true_value: old.said, planted_value: said };
  };
  const remove = (i: number): TurnPlant => {
    const old = t[i]!;
    const k = relayOf(turns, i);
    if (k >= 0) t.splice(k, 1);
    t.splice(i, 1);
    return { turns: t, at: i, true_value: old.said, planted_value: null };
  };
  const f = plan.facts;
  if (id === "C-05") {
    const nums = factNumbers(f);
    for (let i = 0; i < t.length; i++) {
      const turn = t[i]!;
      if (
        (turn.speaker !== "AGENT" && turn.speaker !== "AGENT_2") ||
        !turn.tag.startsWith("quote:")
      )
        continue;
      const tok = numberTokens(turn.said).find(
        (x) => x.kind === "money" && nums.money.has(x.cents),
      );
      if (!tok || tok.kind !== "money") continue;
      const wrong = money(wrongAmount(r, BigInt(tok.cents), plan));
      const said = turn.said.replace(tok.raw, wrong);
      const k = relayOf(turns, i);
      t[i] = { ...turn, said };
      if (k >= 0) t[k] = { ...t[k]!, said: t[k]!.said.split(tok.raw).join(wrong) };
      return { turns: t, at: i, true_value: tok.raw, planted_value: wrong };
    }
    return null;
  }
  const i = t.findIndex((x) => x.tag === def.tag && x.speaker !== "INTERPRETER");
  if (i < 0) return null;
  switch (id) {
    case "C-01": {
      const s = { ...slots };
      const line = f.past_due
        ? "[Well,|Okay, well,] [I can tell you|what I can tell you is] the account is {days_past} past due[,| and] [they owe|the amount due is] {past_due_total}. [They really need to call us.|Have them call us as soon as possible.]"
        : f.next
          ? "[Well, I can tell you|What I can say is] the next payment of {next_amount} is due {next_due}[, so have them call if they have questions|]."
          : "[I can tell you|Well,] the principal balance is {upb}.";
      const es = f.past_due
        ? "Dice que la cuenta tiene {dias} de atraso y que deben {past_due_total}."
        : f.next
          ? "Dice que el próximo pago de {next_amount} vence el {next_due_es}."
          : "Dice que el saldo de capital es {upb}.";
      return replace(i, expand(r, line, s), expand(r, es, s));
    }
    case "C-02":
      return replace(
        i,
        expand(
          r,
          f.past_due
            ? "[I see you're|The account is] {days_past} past due, and [we need|you need] to bring the account current. [The amount due is|You owe] {past_due_total}. [Can we set up a payment today?|When can you make that payment?]"
            : "[I do need to remind you|Just a reminder] that your payment [is due|needs to be made] on time, [and we expect|we're going to need] the full payment of {next_amount} by {next_due}.",
          slots,
        ),
        expand(
          r,
          f.past_due
            ? "Dice que tiene {dias} de atraso y que debe ponerse al corriente con {past_due_total}."
            : "Dice que espera el pago completo de {next_amount}.",
          slots,
        ),
      );
    case "C-03":
      return replace(
        i,
        expand(
          r,
          "[Oh, no,|No, no,|Don't worry,] this won't hurt your credit[, that's only if it goes to foreclosure|, as long as you get caught up|. We don't report that].",
          slots,
        ),
        "Dice que no se preocupe, que esto no va a afectar su crédito.",
      );
    case "C-04":
      return replace(
        i,
        expand(
          r,
          "[I understand.|Okay.|I hear you.] [Unfortunately there's not much I can do about that.|That's just how the system works.|I can't really do anything about that from here.]",
          slots,
        ),
        "Dice que entiende, pero que no puede hacer nada.",
      );
    case "C-06":
    case "C-07":
      return remove(i);
    default:
      return null;
  }
}

/** Plant a contradiction in a note: a figure changed, or a status the record does not have. */
export function plantInNote(
  r: Rng,
  text: string,
  plan: CallPlan,
): { text: string; true_value: string; planted_value: string } {
  const toks = numberTokens(text);
  const m = toks.find((t) => t.kind === "money");
  if (m && m.kind === "money") {
    const wrong = wrongAmount(r, BigInt(m.cents), plan);
    // Written the way the note wrote the true figure: with or without the dollar sign and the commas.
    let raw = money(wrong);
    if (!m.raw.includes(",")) raw = raw.replace(/,/g, "");
    if (!m.raw.startsWith("$")) raw = raw.slice(1);
    return { text: text.replace(m.raw, raw), true_value: m.raw, planted_value: raw };
  }
  const d = toks.find((t) => t.kind === "date");
  if (d && d.kind === "date") {
    const day = Math.min(28, Math.max(1, d.d + (d.d > 14 ? -r.int(3, 9) : r.int(3, 9))));
    const raw = d.raw.replace(
      /^(\d{1,2})\/(\d{1,2})/,
      (_m, mo: string, dd: string) =>
        `${mo}/${dd.length === 2 ? String(day).padStart(2, "0") : day}`,
    );
    return { text: text.replace(d.raw, raw), true_value: d.raw, planted_value: raw };
  }
  const claim = plan.facts.past_due ? "ACCT CURRENT." : "ACCT PAST DUE, LC ASSESSED.";
  const truth = plan.facts.past_due ? `ACCT ${plan.facts.past_due.days} DPD.` : "ACCT CURRENT.";
  return { text: `${text} ${claim}`, true_value: truth, planted_value: claim };
}
