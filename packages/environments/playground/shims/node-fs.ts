/**
 * `node:fs`, for the browser: every name the environments import, none of it
 * callable. `src/record.ts` imports `appendFileSync` and `mkdirSync` for its
 * run recorder, which only the CLI constructs; the playground never writes a
 * file, so reaching one of these is a defect and says so.
 */

const absent =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`node:fs ${name} is not available in the browser playground`);
  };

export const appendFileSync = absent("appendFileSync");
export const mkdirSync = absent("mkdirSync");
export const readFileSync = absent("readFileSync");
export const writeFileSync = absent("writeFileSync");
export const existsSync = absent("existsSync");
export const readdirSync = absent("readdirSync");
export const statSync = absent("statSync");

export default {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
};
