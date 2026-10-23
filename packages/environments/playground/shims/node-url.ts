/**
 * `node:url`, for the browser: every name the environments import, none of it
 * callable. The life generator's calibration reader imports `fileURLToPath` to
 * find its file beside the module; call-qa reads the typed defaults
 * (`defaultCalibration`), which names no path, so reaching this is a defect
 * and says so.
 */

const absent =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`node:url ${name} is not available in the browser playground`);
  };

export const fileURLToPath = absent("fileURLToPath");
export const pathToFileURL = absent("pathToFileURL");

export default { fileURLToPath, pathToFileURL };
