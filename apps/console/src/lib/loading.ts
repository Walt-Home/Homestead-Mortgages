/**
 * What the loading screen says under its spinner, by how long it has been
 * spinning. Pure, so it can be tested without a browser.
 */
export function loadingLine(seconds: number): string {
  if (seconds < 4) return "";
  if (seconds < 15) return "Checking with the servicing app.";
  return "Still waking the servicing app. It sleeps when nobody is using it and can take a minute to come back; this page carries on by itself.";
}
