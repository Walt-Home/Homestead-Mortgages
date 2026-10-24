/**
 * One training package for each defect in the registry a package carries
 * (the first ten), with that defect alone on its one loan: what the servicing
 * app's own boarding is shown, to say which of the ten its gate catches
 * (`apps/servicing/scripts/board-life-package.mjs`). Each is the first task of
 * the defect's own plan whose draws are no held-out task's; the held-out suite
 * is never written out.
 *
 * A module of its own, apart from the environment's index, because it reads
 * the held-out guard, and the guard reads the environment's index.
 */

import { drawsHeldoutStream } from "../heldout-guard.js";
import { DEFECTS } from "../life/defects.js";
import {
  BOARDING_PLAN_NAMES,
  boardingTaskId,
  generateBoardingTask,
  type BoardingPlan,
} from "./generator.js";
import type { BoardingTask } from "./task.js";

/** The training seed the packages are drawn from. */
export const ONE_OF_EACH_SEED = 5;

export function oneOfEach(seed: number = ONE_OF_EACH_SEED): { id: string; task: BoardingTask }[] {
  // The defects a package carries: the history errors are made after boarding, and have no package to write.
  const inPackages = Object.keys(DEFECTS).filter((id) => DEFECTS[id]!.package !== null);
  return inPackages.map((id) => {
    const plan = `${id.toLowerCase().replace("-", "")}_one`;
    const at = BOARDING_PLAN_NAMES.indexOf(plan as BoardingPlan);
    if (at < 0) throw new Error(`${id} has no plan of its own`);
    for (let index = at; ; index += BOARDING_PLAN_NAMES.length)
      if (!drawsHeldoutStream(boardingTaskId("train", seed, index)))
        return { id, task: generateBoardingTask("train", seed, index) };
  });
}
