/**
 * The serializer, for a test that needs bytes the gate would not let through.
 *
 * `emitDocument` is not on `@hm/du`'s public surface, because a caller holding
 * both the assembler and the serializer can compose them and get a document no
 * check ever saw — which makes `emitSubmission`'s refusal a report rather than
 * a gate. The door is here instead: under `__tests__`, out of the package's
 * `exports` map, so nothing this repository ships can reach it at run time and
 * a test can.
 *
 * What needs it: no application this repository can assemble is emittable
 * today. Eight data points the specification requires on the loan being applied
 * for and on the subject property have no column anywhere — `docs/du-readiness.md`
 * names all eight — so `emitSubmission` refuses every casefile, and the
 * questions "which row becomes which element" and "does the whole document
 * validate" would go unasked until those columns exist.
 */

export { emitDocument } from "../../emit.js";
