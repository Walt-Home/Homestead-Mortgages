/**
 * The two read-only refusals travel together.
 *
 * A screen that posts to a file can be refused for two reasons: the file is a
 * sample one (`DEMO_FILE_READ_ONLY`), or the session is a sample borrower
 * (`PERSONA_READ_ONLY`). They arrive from the same button and mean the same
 * thing to whoever pressed it, so a screen that answers one and not the other
 * drops a person into the server's own sentence — which talks about sessions
 * and sample borrowers, not about the thing they were trying to do.
 *
 * The set is keyed on meeting EITHER refusal rather than on the file one, so
 * it holds the screens that can only meet the session one: the review screen
 * signs, and the privacy screen deletes an account, and neither of those is a
 * write against a file that could be a sample file. Keyed on the file code
 * alone, both were outside the set and nothing here was checked of them.
 *
 * Nothing in a render test can see that: the branch that is missing is
 * missing, and the fallback renders perfectly well. So this reads the source,
 * the way the design-system rules do.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONA_READ_ONLY } from "../lib/auth.js";

const SRC = new URL("..", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  name: path.slice(SRC.length),
  text: readFileSync(path, "utf8"),
}));

/** A screen is in the set when it reads either refusal off an error. */
const READ_ONLY_CODE = /code === "(?:DEMO_FILE_READ_ONLY|PERSONA_READ_ONLY)"/;

const meetsTheRefusal = FILES.filter((f) => READ_ONLY_CODE.test(f.text));

describe("a screen that can meet a read-only refusal", () => {
  it("is a set somebody would notice shrinking", () => {
    // If this drops to nothing the rest of the file is vacuously true, and a
    // screen that quietly left the set is a screen showing the server's words.
    expect(meetsTheRefusal.map((f) => f.name).sort()).toEqual([
      "components/ConnectorStep.tsx",
      "pages/BankPage.tsx",
      "pages/DeclarationsPage.tsx",
      "pages/IdentityPage.tsx",
      "pages/PrivacyPage.tsx",
      "pages/ReviewPage.tsx",
    ]);
  });

  it("answers the sample-session refusal, whichever one brought it here", () => {
    // The file refusal is the one a screen naturally writes first — it is the
    // older rule. The session one is refused on every route at once, so a
    // screen that handles either has to handle this.
    for (const file of meetsTheRefusal) {
      expect(file.text, file.name).toContain('code === "PERSONA_READ_ONLY"');
    }
  });

  it("says it in the shared words rather than its own", () => {
    // One sentence, in one place. A screen that wrote its own would drift the
    // moment the copy changed anywhere else.
    for (const file of meetsTheRefusal) {
      expect(file.text, file.name).toMatch(
        /import \{[^}]*PERSONA_READ_ONLY[^}]*\} from "\.\.?\/.*auth\.js"/,
      );
      // Straight into the error state, or through this file's own named
      // handler: the review and privacy screens funnel every refusal through
      // one function so the words are a rule rather than a branch, and the
      // result of that call is the same promise as the constant itself.
      expect(file.text, file.name).toMatch(/setError\((?:PERSONA_READ_ONLY|[A-Za-z]+\(err\))/);
      // Imported AND used. An import the screen never reaches for would
      // satisfy the line above and show nothing.
      expect(file.text.match(/\bPERSONA_READ_ONLY\b/g)?.length ?? 0, file.name).toBeGreaterThan(1);
      expect(file.text, file.name).not.toContain(`"${PERSONA_READ_ONLY}"`);
    }
  });
});
