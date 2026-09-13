/**
 * Types for the plain-JavaScript script beside this file.
 *
 * The script is `.mjs` because `db:test:setup` runs it with bare node before
 * anything is built. It is imported from TypeScript in two places — the API's
 * vitest config and the advisory lock its global setup takes — and both need
 * the name of the database the suite is pointed at to come from ONE place. A
 * second copy of the naming rule is how a suite ends up truncating a database
 * nobody meant to give it.
 */
export declare function testDatabaseUrl(): string;
