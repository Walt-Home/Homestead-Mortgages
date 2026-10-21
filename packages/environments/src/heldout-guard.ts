/**
 * No train task draws a held-out task's stream.
 *
 * Every task draws from a stream seeded with `hash32` of its key (`rng.ts`),
 * a 32-bit FNV-1a. A train key and a held-out key differ by their split, but
 * 32 bits collide, and FNV-1a can be run backward a character at a time: for
 * any held-out key, a search finds train coordinates hashing to the same seed
 * in under a second. Four ordinary ones already do: escrow-analysis 1.0.0,
 * train seed 5920, indexes 9554, 9555, 9558 and 9559 are held-out tasks 29,
 * 28, 25 and 24. A train task at such coordinates is that held-out task. The
 * stream is the same, every key derived from it is the same (FNV-1a is
 * sequential, so `${id}/tape`, `${id}/ledger` and `${id}#3` collide with the
 * id), and so is refi's loan id, which is the hash itself.
 *
 * Environments share draws, too: refi-tape and refi-hard write their tapes
 * over the loan refi-review draws from the same stream, escrow-history its
 * ledger over escrow-analysis's account, and regz-apr's quotes are
 * regz-price-tests'. So a train id is checked against the held-out suite of
 * every environment, not only its own.
 *
 * Until the stream is keyed wider, which moves every suite and so bumps every
 * environment's version, this is the guard: whoever draws the train split
 * (the runner, a trainer, the playground) refuses or skips an id it names.
 * It reads held-out ids, never a held-out task. It checks the first draw and
 * every redraw on both sides, so it also turns away train coordinates whose
 * task is no held-out task's: about one in 3,000, measured over 180,000.
 */

import { hash32 } from "./rng.js";
import { HELDOUT_SUITE, taskId } from "./refi/index.js";
import { TAPE_HELDOUT_SUITE, tapeTaskId } from "./refi-tape/index.js";
import { HARD_HELDOUT_SUITE, hardTaskId } from "./refi-hard/index.js";
import { ESCROW_HELDOUT_SUITE, escrowTaskId } from "./escrow/index.js";
import { HISTORY_HELDOUT_SUITE, historyTaskId } from "./escrow-history/index.js";
import { REGZ_HELDOUT_SUITE, regzTaskId } from "./regz/index.js";
import { REGZ_APR_HELDOUT_SUITE, regzAprTaskId } from "./regz-apr/index.js";
import { FLEX_HELDOUT_SUITE, flexTaskId } from "./flexmod/index.js";
import { PAYMENTS_HELDOUT_SUITE, paymentsTaskId } from "./payments/index.js";
import { ARM_HELDOUT_SUITE, armTaskId } from "./arm/index.js";
import { PAYOFF_HELDOUT_SUITE, payoffTaskId } from "./payoff/index.js";
import { PMI_HELDOUT_SUITE, pmiTaskId } from "./pmi/index.js";
import { METRO2_HELDOUT_SUITE, metro2TaskId } from "./metro2/index.js";

/** A held-out suite: the `name/version` its ids are drawn under, and its seed and size. */
export interface HeldoutSuite {
  readonly namespace: string;
  readonly seed: number;
  readonly n: number;
}

/** `name/version` of an id `name/version/split/seed/index`. */
export function namespaceOf(id: string): string {
  const parts = id.split("/");
  if (parts.length < 5 || parts.slice(-2).some((p) => !/^\d+$/.test(p)))
    throw new RangeError(`${id} is not a task id`);
  return parts.slice(0, -3).join("/");
}

const today = (
  id: (split: "heldout", seed: number, index: number) => string,
  suite: { readonly seed: number; readonly n: number },
): HeldoutSuite => ({ namespace: namespaceOf(id("heldout", suite.seed, 0)), ...suite });

/**
 * Every held-out suite a reported score was measured on. Today's are read
 * from the environments' own ids. The retired ones are the namespaces an
 * earlier version drew its suite under; when a version bump moves a
 * namespace, the old one goes on this list. A policy environment draws its
 * procedure environment's tasks, so it has no namespace of its own.
 */
export const HELDOUT_SUITES: readonly HeldoutSuite[] = Object.freeze([
  today(taskId, HELDOUT_SUITE),
  today(tapeTaskId, TAPE_HELDOUT_SUITE),
  today(hardTaskId, HARD_HELDOUT_SUITE),
  today(escrowTaskId, ESCROW_HELDOUT_SUITE),
  today(historyTaskId, HISTORY_HELDOUT_SUITE),
  today(regzTaskId, REGZ_HELDOUT_SUITE),
  today(regzAprTaskId, REGZ_APR_HELDOUT_SUITE),
  today(flexTaskId, FLEX_HELDOUT_SUITE),
  today(paymentsTaskId, PAYMENTS_HELDOUT_SUITE),
  today(armTaskId, ARM_HELDOUT_SUITE),
  today(payoffTaskId, PAYOFF_HELDOUT_SUITE),
  today(pmiTaskId, PMI_HELDOUT_SUITE),
  today(metro2TaskId, METRO2_HELDOUT_SUITE),
  { namespace: "refi-tape/1.0.0", ...TAPE_HELDOUT_SUITE },
  { namespace: "refi-hard/1.0.0", ...HARD_HELDOUT_SUITE },
  { namespace: "regz-price-tests/1.0.0", ...REGZ_HELDOUT_SUITE },
  { namespace: "regz-apr/1.0.0", ...REGZ_APR_HELDOUT_SUITE },
  { namespace: "flexmod-terms/1.0.0", ...FLEX_HELDOUT_SUITE },
]);

/** Redraw keys after the first, `${id}#1` to `${id}#60`: past every generator's attempts. */
export const REDRAW_KEYS = 60;

const keysOf = (id: string): string[] =>
  Array.from({ length: REDRAW_KEYS + 1 }, (_, a) => (a === 0 ? id : `${id}#${a}`));

let heldoutSeeds: ReadonlySet<number> | null = null;

/** Every stream seed any held-out task can draw from, redraws included: built once, on first use. */
function seeds(): ReadonlySet<number> {
  if (!heldoutSeeds) {
    const s = new Set<number>();
    for (const suite of HELDOUT_SUITES)
      for (let i = 0; i < suite.n; i++)
        for (const k of keysOf(`${suite.namespace}/heldout/${suite.seed}/${i}`)) s.add(hash32(k));
    heldoutSeeds = s;
  }
  return heldoutSeeds;
}

/**
 * Whether the task `id` would draw, at its first draw or any redraw, from a
 * stream some held-out task can draw from. An id under a namespace no suite
 * is listed for is refused outright: its held-out suite is unknown here.
 */
export function drawsHeldoutStream(id: string): boolean {
  const namespace = namespaceOf(id);
  if (!HELDOUT_SUITES.some((s) => s.namespace === namespace))
    throw new Error(`no held-out suite is listed for ${namespace}; add it to HELDOUT_SUITES`);
  const held = seeds();
  return keysOf(id).some((k) => held.has(hash32(k)));
}

/** A train suite's indexes from 0 to n - 1, split into those it may draw and those it may not. */
export function trainIndexes(
  idOf: (index: number) => string,
  n: number,
): { readonly kept: number[]; readonly left_out: number[] } {
  const kept: number[] = [];
  const left_out: number[] = [];
  for (let i = 0; i < n; i++) (drawsHeldoutStream(idOf(i)) ? left_out : kept).push(i);
  return { kept, left_out };
}
