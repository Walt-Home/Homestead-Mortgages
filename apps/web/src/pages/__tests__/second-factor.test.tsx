/**
 * The second step's screens, as first rendered.
 *
 * Effects do not run in a static render, so the enrollment screen is seen
 * before the server has answered — which is the state to check: nothing to
 * scan yet, the button held back, and a way out of the room. The verify
 * screen is checked for its two faces, since the toggle between them is the
 * only control on it besides the code.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SecondFactorPage } from "../SecondFactorPage.js";
import { SECOND_FACTOR_COPY as COPY } from "../../lib/second-factor.js";

const session = vi.hoisted(() => ({
  user: { email: "person@example.test", persona: null },
  signOut: async () => undefined,
  completeSecondFactor: () => undefined,
}));
vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => session,
}));

const render = (mode: "enroll" | "verify" | "replace") =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SecondFactorPage mode={mode} />
    </MemoryRouter>,
  );

describe("enrolling", () => {
  const html = render("enroll");

  it("asks for the app before the server has answered, with the button held back", () => {
    expect(html).toContain(COPY.enroll.title);
    expect(html).toContain(COPY.enroll.body);
    expect(html).not.toContain("<img");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("offers a way out to somebody without their phone", () => {
    expect(html).toContain(COPY.signOut);
    expect(html).toContain("person@example.test");
  });
});

describe("verifying", () => {
  const html = render("verify");

  it("asks for the six digits and offers the recovery code instead", () => {
    expect(html).toContain(COPY.verify.title);
    expect(html).toContain(COPY.verify.codeLabel);
    expect(html).toContain(COPY.verify.useRecovery);
    expect(html).not.toContain(COPY.verify.recoveryLabel);
    expect(html).toMatch(/autocomplete="one-time-code"/i);
  });

  it("offers the same way out", () => {
    expect(html).toContain(COPY.signOut);
  });
});

describe("a new phone", () => {
  const html = render("replace");

  it("is the enrollment, inside the app rather than standing alone", () => {
    expect(html).toContain(COPY.replace.title);
    expect(html).toContain(COPY.replace.body);
    expect(html).not.toContain(COPY.signOut);
    expect(html).toContain('href="/privacy"');
  });
});
