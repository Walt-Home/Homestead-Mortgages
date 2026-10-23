/**
 * The life generator: ten-year loan histories over the ported servicing
 * engines, for the environments to draw their tasks from.
 *
 * It is a library module inside @hm/environments and not a workspace of its
 * own. The engines it runs are the environments' ports (`src/<env>/ported`), and the
 * environments built on it import it; as a package it would depend on
 * @hm/environments for the ports while the environments depended on it, a
 * cycle. As a module, both sides are the same package.
 *
 * `generate(seed, scenario, { defects })` returns a book: each loan's draw,
 * its month-by-month history (receipts, fees, disbursements, analyses, ARM
 * changes, MI events, contacts, the installment ledger, month-ends with their
 * Metro 2 records) and, when defects are asked for, the defective twin and
 * its labels. `monthEndRow` and `bookTape` project a month-end onto what a
 * partner's tape carries, `writeTape` and `tapeStream` write it in the m3-v1
 * layout, and `plantTapeDefects` plants what a delivery does to the files.
 * See docs/environments.md, "The life generator".
 */

export * from "./calibration.js";
export * from "./behavior.js";
export * from "./feeds.js";
export * from "./draw.js";
export * from "./scenario.js";
export * from "./simulate.js";
export * from "./defects.js";
export * from "./generate.js";
export * from "./projection.js";
export * from "./tape.js";
export * from "./tape-defects.js";
export * from "./check.js";
export * from "./transfer-package.js";
export * from "./demo.js";
