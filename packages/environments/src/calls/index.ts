/**
 * The call rubric: what a QA reviewer fails a servicing call for, from the
 * servicing app's collections spec (11.1), with the two checks of its
 * conversation harness that carry over to a telephone call, ported. It is
 * not an environment; call-qa grades with it. See docs/environments.md,
 * "call-qa".
 */

export * from "./phrases.js";
export * from "./predial.js";
export * from "./record.js";
export * from "./rubric.js";
export * from "./templates.js";
export {
  digitRuns,
  figureRuns,
  provenanceCheck,
  templateLiteral,
  templateMatches,
  verbatimCheck,
} from "./ported/checks.js";
export type { CheckResult, EvalMessage, EvalTemplate } from "./ported/types.js";
