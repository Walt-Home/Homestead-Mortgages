/**
 * Ours, not the servicing app's. The ported boarding types (`ported/types.ts`)
 * name the inherited loss-mitigation file's type from
 * `apps/servicing/src/domain/transfers/ops-1-7.ts`, which is stateful (events,
 * the in-flight loss-mitigation store, inbound transfers) and does not port.
 * Nothing the environment grades reads that field, so its type is stood in
 * for here; the port's own import line names this file instead.
 */
export type InheritedLossmitFile = Readonly<Record<string, unknown>>;
