/**
 * The in-memory borrower, re-exported from the package that owns the engine.
 *
 * It used to live here, and the outcome test that reads it had to live here
 * too — which left `determineOutcome`, `determineRecommendation` and
 * `adverseActionReasonsFor` with no test inside `@hm/underwriting`, the
 * workspace that holds them. The fixture has no Prisma in it: it is a
 * `LoanFile` and the connector walk that grows one, so it belongs beside the
 * engine, and the two API tests that also read it reach it through here rather
 * than through a second copy.
 */

export * from "@hm/underwriting/test-support";
