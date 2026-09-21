/**
 * The tape reader: a partner's book, in its own layout, read into the one
 * shape a servicer's file may enter the product in.
 *
 * Step 2 of the servicing plan. The profile and parsers are a port of Doug's
 * §33.1 onto the vendored kernel; the derivation onto `@hm/shared/portfolio`
 * is ours, and so are the two things it refuses to carry — see `book.ts`.
 */

export * from "./m3-v1.js";
export * from "./tabular.js";
export * from "./book.js";
export { readXlsx, writeXlsx, excelSerialToIsoDate } from "./vendored/xlsx.js";
export * from "./fixtures/northlight.js";
