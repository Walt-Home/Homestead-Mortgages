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
 * What needs it: the tests that ask "which row becomes which element" and
 * "does the whole document validate" of a fixture the gate would refuse — one
 * deliberately short of a product, a building fact or a declared job. The
 * columns that once made EVERY casefile unemittable are built now
 * (`docs/du-readiness.md`); this stays because a fixture is allowed to be
 * short of them and the mapping is still worth asking about.
 */

export { emitDocument } from "../../emit.js";
