/**
 * `node:url`, for the browser: every name the environments import, none of it
 * callable. `src/life/calibration.ts` imports `fileURLToPath` to find the
 * calibration file beside it, which only `loadCalibration` reads; the
 * environments built on the life generator draw from its typed defaults, so
 * reaching this is a defect and says so.
 */

const absent =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`node:url ${name} is not available in the browser playground`);
  };

export const fileURLToPath = absent("fileURLToPath");

export default { fileURLToPath };
