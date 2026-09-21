/**
 * Doug's kernel, one namespace per module. Everything under `./kernel` is
 * vendored byte for byte from doug-ludlow/Supermortgage — `../VENDORED_FROM`
 * has the commit — and this file is the only thing in `src/` that is ours.
 *
 * Reach a module by its subpath (`@hm/kernel/calendar`) or take the namespace
 * from here. The root does not flatten the seven into one export list on
 * purpose: the calendar exports `min`, `max`, `compare` and `parts`, and
 * nothing should reach those without saying which vocabulary it means.
 */
export * as money from "./kernel/money/index.js";
export * as calendar from "./kernel/calendar/index.js";
export * as ledger from "./kernel/ledger/index.js";
export * as fsm from "./kernel/fsm/index.js";
export * as events from "./kernel/events/index.js";
export * as timers from "./kernel/timers/index.js";
export * as concurrency from "./kernel/concurrency.js";
