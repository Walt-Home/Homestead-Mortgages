/**
 * `node:path`, for the browser: every name the environments import, none of
 * it callable. `src/record.ts` imports `dirname` for its run recorder, which
 * only the CLI constructs, so reaching one of these is a defect and says so.
 */

const absent =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`node:path ${name} is not available in the browser playground`);
  };

export const dirname = absent("dirname");
export const join = absent("join");
export const resolve = absent("resolve");
export const relative = absent("relative");
export const basename = absent("basename");

export default { dirname, join, resolve, relative, basename };
