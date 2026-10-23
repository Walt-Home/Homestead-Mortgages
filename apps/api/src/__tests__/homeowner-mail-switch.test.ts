import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Production's homeowner-mail switch is production's own variable. GitHub
 * resolves `vars.X` from the deployment's environment first and then from the
 * repository, and the repository's HOMEOWNER_MAIL is staging's: read under that
 * name, production deployed with homeowner mail on (21 October 2026). Read out
 * of the file, because nothing else here can run a workflow.
 */
describe("production's homeowner-mail switch", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const yaml = readFileSync(join(root, ".github", "workflows", "deploy-production.yml"), "utf8");

  it("is read from a name only production sets", () => {
    expect(yaml).not.toMatch(/vars\.HOMEOWNER_MAIL\b/);
    expect(yaml).toMatch(/vars\.PRODUCTION_HOMEOWNER_MAIL/);
  });

  it("fails the deploy when the service reads on and production did not say so", () => {
    expect(yaml).toMatch(/homeownerMail":"on"[\s\S]*?PRODUCTION_HOMEOWNER_MAIL[\s\S]*?exit 1/);
  });
});
