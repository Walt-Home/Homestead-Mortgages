/**
 * A call's transcript, from its plan: the writer's turns, a planted defect
 * when one is asked for, the timing, and the recognizer's noise.
 *
 * The timing fills the call exactly. The phone menu runs from zero to the
 * agent's answer at its own pace; from the answer on, every spoken turn takes
 * its words at its speaker's rate plus a pause, the holds and the transfer
 * take their seconds, and the speech is stretched or squeezed so the last
 * turn ends at the contact row's duration. So a transcript is as long as the
 * call: the duration drawn from the calibration's handle time.
 *
 * Each turn's noise draws from a stream keyed by its place in the writer's
 * clean turns, so planting a defect in one turn leaves every other turn's
 * text as the clean book has it.
 */

import { rngFor } from "../rng.js";
import { plantInTurns, type ContactDefectId, type TurnPlant } from "./defects.js";
import { clock } from "./format.js";
import { recognize } from "./noise.js";
import type { CallPlan } from "./plan.js";
import type { NoiseOp, Speaker, Transcript, Turn } from "./types.js";
import { slotsOf, templateWriter, type ContactTextWriter, type DraftTurn } from "./writer.js";

const RATE: Record<Speaker, number> = {
  AGENT: 2.6,
  AGENT_2: 2.5,
  CALLER: 2.4,
  IVR: 2.1,
  INTERPRETER: 2.5,
  SYSTEM: 1,
};
const SWAP_SHORT_TURN = 0.06;
const CROSSTALK = 0.05;

export interface BuiltTranscript {
  readonly transcript: Transcript;
  /** Present when a defect was planted: where, and what changed. */
  readonly plant: (Omit<TurnPlant, "turns"> & { readonly defect: ContactDefectId }) | null;
}

export interface TranscriptOptions {
  readonly writer?: ContactTextWriter;
  readonly defect?: ContactDefectId | null;
}

export function buildTranscript(
  plan: CallPlan,
  opts: TranscriptOptions = {},
): BuiltTranscript | null {
  const writer = opts.writer ?? templateWriter;
  const clean = writer.callTurns(plan).map((t, i) => ({ ...t, orig: i }));
  let drafts: (DraftTurn & { orig: number })[] = clean;
  let plant: BuiltTranscript["plant"] = null;
  // A note's contradiction (C-08) is the note's; every other defect is planted in one turn.
  if (opts.defect && opts.defect !== "C-08") {
    const p = plantInTurns(
      opts.defect,
      rngFor(`${plan.key}/defect/${opts.defect}`),
      plan,
      slotsOf(plan),
      clean,
    );
    if (!p) return null;
    drafts = p.turns as (DraftTurn & { orig: number })[];
    plant = {
      defect: opts.defect,
      at: p.at,
      true_value: p.true_value,
      planted_value: p.planted_value,
    };
  }

  // Timing: the menu, then the call proper, stretched to the row's duration.
  const firstAgent = drafts.findIndex((t) => t.speaker === "AGENT");
  const answer = firstAgent < 0 ? 0 : firstAgent;
  const r = rngFor(`${plan.key}/time`);
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  for (let i = 0; i < answer; i++) {
    const t = drafts[i]!;
    const secs = t.hold_s ?? t.said.split(/\s+/).length / RATE[t.speaker] + 0.6;
    starts.push(at);
    at += secs;
    ends.push(at);
  }
  const answeredAt = Math.round(at);
  // Speech at its speaker's rate; the time the words do not fill is dead air between turns (the agent
  // reading, typing, waiting on a screen), most of it in a few long gaps. Speech is stretched only when
  // the gaps would average more than five seconds, and squeezed when the words overrun the call.
  const rest = drafts.slice(answer);
  const speech = rest.map((t) =>
    t.hold_s !== undefined ? 0 : t.said.split(/\s+/).length / RATE[t.speaker],
  );
  const weight = rest.map(() => {
    const u = r.next();
    return u < 0.12 ? 6 + r.next() * 10 : 0.3 + r.next() * 0.9;
  });
  const fixed = rest.reduce((s, t) => s + (t.hold_s ?? 0), 0);
  const target = Math.max(1, plan.talk_s - fixed);
  const spoken = speech.reduce((s, x) => s + x, 0);
  const minGaps = rest.length * 0.3;
  let stretch = 1;
  if (spoken + minGaps > target)
    stretch = Math.max(0.05, (target - minGaps) / Math.max(spoken, 1e-9));
  else if ((target - spoken) / Math.max(1, rest.length) > 5)
    stretch = Math.min(1.5, (target - rest.length * 5) / Math.max(spoken, 1e-9));
  stretch = Math.max(stretch, 0.05);
  const gapTotal = Math.max(0, target - spoken * stretch);
  // No silence runs past 25 seconds while another gap has room; past that, the rest is spread evenly.
  const wsum = weight.reduce((s, x) => s + x, 0) || 1;
  const gaps = weight.map((w, k) =>
    rest[k]!.hold_s !== undefined ? 0 : Math.min(25, (gapTotal * w) / wsum),
  );
  const short = gapTotal - gaps.reduce((s, x) => s + x, 0);
  const open = gaps.filter((g, k) => rest[k]!.hold_s === undefined && g < 25).length;
  if (short > 0)
    gaps.forEach((g, k) => {
      if (rest[k]!.hold_s !== undefined) return;
      gaps[k] = g + (open ? (g < 25 ? short / open : 0) : short / rest.length);
    });
  at = answeredAt;
  rest.forEach((t, k) => {
    const gap = gaps[k]!;
    at += gap;
    starts.push(at);
    at += t.hold_s !== undefined ? t.hold_s : speech[k]! * stretch;
    ends.push(at);
  });
  // Any rounding lands on the last turn, so the call ends at its duration.
  if (ends.length) ends[ends.length - 1] = answeredAt + plan.talk_s;

  // Labels: the stereo recorder's channels, or a mono recording's diarization.
  const stereo = plan.recording === "stereo";
  const mono = new Map<Speaker, string>();
  const labelOf = (s: Speaker): string => {
    if (s === "SYSTEM") return "";
    if (s === "IVR") return "IVR";
    if (stereo)
      return s === "AGENT" || s === "AGENT_2"
        ? "Agent"
        : s === "INTERPRETER"
          ? "Interpreter"
          : "Customer";
    if (!mono.has(s)) mono.set(s, `Speaker ${mono.size + 1}`);
    return mono.get(s)!;
  };
  const lower = rngFor(`${plan.key}/engine`).chance(0.4);
  const turns: Turn[] = drafts.map((t, i) => {
    const nr = rngFor(`${plan.key}/asr/${t.orig}`);
    const noise: NoiseOp[] = [];
    let start = starts[i]!;
    const end = ends[i]!;
    let label = labelOf(t.speaker);
    if (t.speaker === "SYSTEM") {
      const secs = Math.round(t.hold_s ?? 0);
      const text =
        t.said.startsWith("[DTMF") || t.said === "[call ended]"
          ? t.said
          : `${t.said.slice(0, -1)} ${clock(secs)}]`;
      return {
        speaker: t.speaker,
        label,
        start_s: round1(start),
        end_s: round1(end),
        said: t.said,
        text,
        noise,
        tag: t.tag,
        facts: [],
        defect: null,
      };
    }
    const rec = recognize(nr, t.said, t.pii, lower);
    noise.push(...rec.noise);
    let text = rec.text;
    const words = t.said.split(/\s+/).length;
    const uSwap = nr.next();
    const uCross = nr.next();
    if (!stereo && words <= 4 && t.speaker !== "IVR" && uSwap < SWAP_SHORT_TURN) {
      const other = [...mono.entries()].find(([s]) => s !== t.speaker && s !== "IVR")?.[1];
      if (other) {
        noise.push({ kind: "speaker_swapped", label: other });
        label = other;
      }
    }
    if (t.tag === "backchannel" && i > 0 && uCross < CROSSTALK * 4) {
      start = Math.max(starts[i - 1]!, start - Math.min(1.5, end - start + 0.8));
      text = `[crosstalk] ${text}`;
      noise.push({ kind: "crosstalk" });
    }
    const plantedHere = plant !== null && plant.planted_value !== null && i === plant.at;
    return {
      speaker: t.speaker,
      label,
      start_s: round1(start),
      end_s: round1(end),
      said: t.said,
      text,
      noise,
      tag: t.tag,
      facts: [],
      defect: plantedHere ? plant!.defect : null,
    };
  });
  return {
    transcript: {
      contact_id: plan.contact.id,
      loan_id: plan.contact.loan_id,
      on: plan.contact.on,
      recording: plan.recording,
      answered_at_s: answeredAt,
      duration_s: plan.talk_s,
      turns,
      writer: writer.id,
    },
    plant,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The transcript as the recorder exports it: one line a turn, timestamped. */
export function renderTranscript(t: Transcript): string {
  const head = `Call ${t.contact_id} · ${t.on} · ${t.recording} · ${clock(t.answered_at_s + t.duration_s)}`;
  const lines = t.turns.map((x) =>
    x.speaker === "SYSTEM"
      ? `[${clock(x.start_s)}] ${x.text}`
      : `[${clock(x.start_s)}] ${x.label}: ${x.text}`,
  );
  return [head, ...lines].join("\n");
}
