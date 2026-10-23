/**
 * `node:url`, for the browser: every name the environments import, none of
 * it callable. `src/life/calibration.ts` imports `fileURLToPath` to find
 * calibration.json beside it when it is given no path. The environments
 * built on the life generator ask for the typed defaults
 * (`defaultCalibration`, an empty path, whose read the fs shim refuses and
 * the reader takes as no file), so nothing calls it, and reaching it is a
 * defect and says so.
 */

const absent =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`node:url ${name} is not available in the browser playground`);
  };

export const fileURLToPath = absent("fileURLToPath");
export const pathToFileURL = absent("pathToFileURL");

export default { fileURLToPath, pathToFileURL };
