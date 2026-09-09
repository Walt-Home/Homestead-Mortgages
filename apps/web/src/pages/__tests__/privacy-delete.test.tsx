/**
 * Who is offered the button that deletes an account.
 *
 * `DELETE /api/auth/me` used to be the one write nobody signed in could fail
 * at, and the page was written that way: no error state, no `finally`. A
 * sample borrower is now refused, so the card has to know it is looking at
 * one — and the handler has to survive the refusal anyway, because a session
 * can become a sample borrower under a page that is already open, and a
 * button stuck on "Deleting…" forever says nothing at all.
 *
 * The rule and the page are checked separately on purpose. A predicate can be
 * right while the JSX ignores it, which is exactly how a hidden control stops
 * being hidden.
 */

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api.js";
import { PERSONA_READ_ONLY } from "../../lib/auth.js";
import { canDelete, deletionRefusal, PrivacyPage } from "../PrivacyPage.js";

/** Who the page thinks is looking. Set per render. */
const session = vi.hoisted(() => ({
  user: null as { email: string; persona: unknown } | null,
  signOut: async () => undefined,
}));

vi.mock("../../lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/auth.js")>()),
  useAuth: () => session,
}));

function privacyPage(user: { email: string; persona: unknown } | null): string {
  session.user = user;
  return renderToStaticMarkup(
    <MemoryRouter>
      <PrivacyPage />
    </MemoryRouter>,
  );
}

const maya = {
  email: "maya_okafor@personas.supermortgage.invalid",
  persona: { key: "maya_okafor" },
};
const person = { email: "someone@example.com", persona: null };

describe("the delete button", () => {
  it("is not offered to a sample borrower", () => {
    expect(canDelete(maya)).toBe(false);
  });

  it("is offered to a real person, and to nobody at all", () => {
    expect(canDelete(person)).toBe(true);
    expect(canDelete(null)).toBe(false);
    expect(canDelete(undefined)).toBe(false);
  });
});

describe("a deletion the server refuses", () => {
  it("says it in the shared words when the session is the reason", () => {
    const refused = new ApiError(
      403,
      "This is a sample borrower. Nothing can be changed while signed in as one.",
      "PERSONA_READ_ONLY",
    );
    expect(deletionRefusal(refused)).toBe(PERSONA_READ_ONLY);
  });

  it("passes anything else along rather than inventing a reason", () => {
    expect(deletionRefusal(new ApiError(500, "Something broke.", "INTERNAL"))).toBe(
      "Something broke.",
    );
    expect(deletionRefusal("not an error at all")).toBe("That did not work.");
  });

  it("gives the button back afterwards", () => {
    /*
     * There is no DOM in these tests, so this reads the handler. The failure
     * it guards is invisible in a render: the call was written with no catch
     * because it could not fail, and a refusal left "Deleting…" disabled for
     * good with an unhandled rejection and nothing on the page.
     */
    const source = readFileSync(new URL("../PrivacyPage.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/try \{[\s\S]*api\.del\("\/auth\/me"\)[\s\S]*?\} catch/);
    expect(source).toContain("setBusy(false)");
  });
});

describe("the card at the foot of the page", () => {
  it("offers a real person the way out", () => {
    const markup = privacyPage(person);
    expect(markup).toContain("Delete my account and files");
    expect(markup).toContain("someone@example.com");
  });

  it("tells a sample borrower there is nothing of theirs, and offers no button", () => {
    const markup = privacyPage(maya);
    expect(markup).toContain("There is no account of yours to delete.");
    expect(markup).not.toContain("Delete my account and files");
  });

  it("tells a visitor to sign in first", () => {
    const markup = privacyPage(null);
    expect(markup).toContain("You are not signed in");
    expect(markup).not.toContain("Delete my account and files");
  });
});
