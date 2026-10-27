/**
 * The commit this console was built from, said quietly under the staff
 * member's name: what a deployment runs, without opening /api/health on the
 * other host. Vite writes it in at build time (vite.config.ts), from the same
 * build argument the API's health reports, so the two cannot name different
 * commits. A build that named none shows nothing.
 */

declare const __BUILD_COMMIT__: string | null | undefined;

const REPOSITORY = "https://github.com/Walt-Home/Homestead-Mortgages";

export const BUILD_COMMIT: string | null =
  typeof __BUILD_COMMIT__ === "string" && /^[0-9a-f]{40}$/.test(__BUILD_COMMIT__)
    ? __BUILD_COMMIT__
    : null;

/** The short id a person reads, and the commit's page it links to. */
export function commitLink(commit: string): { label: string; href: string } {
  return { label: commit.slice(0, 7), href: `${REPOSITORY}/commit/${commit}` };
}
