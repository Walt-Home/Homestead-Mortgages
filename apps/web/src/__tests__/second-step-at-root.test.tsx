/**
 * A Google sign-in lands on the second step, wherever it happened.
 *
 * Sign-in lives on the landing page, at `/`. A session that is identified
 * and not yet authenticated used to render the frame around an empty
 * outlet at exactly that path — the header with the person's email,
 * nothing under it, and no request made — because the frame was a layout
 * route declared as `path="/"` with no index child, and the root matched
 * it ahead of the catch-all that renders the step. Nobody who signs in as
 * a sample borrower or the local developer ever saw it: those sessions
 * skip the step. Everybody who signed in with Google from `/` did.
 *
 * Asserted through `App`, because only the router can see which route the
 * root resolves to.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { SECOND_FACTOR_COPY as COPY } from "../lib/second-factor.js";
import { FINDING_WHERE_YOU_STAND } from "../lib/home-copy.js";

const session = vi.hoisted(() => ({
  value: {} as {
    status: string;
    secondFactor: string | null;
    config: { demoPersonasEnabled?: boolean } | null;
    user: { email: string; persona: null } | null;
    signOut: () => Promise<void>;
    completeSecondFactor: () => void;
  },
}));

vi.mock("../lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.js")>();
  return { ...actual, useAuth: () => session.value };
});

function open(path: string, secondFactor: "enroll" | "verify" | "satisfied"): string {
  session.value = {
    status: "signed-in",
    secondFactor,
    config: { demoPersonasEnabled: false },
    user: { email: "person@example.test", persona: null },
    signOut: async () => {},
    completeSecondFactor: () => {},
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("a session that still owes its second step", () => {
  it("is shown the step at the root, where a Google sign-in lands", () => {
    const html = open("/", "verify");
    expect(html).toContain(COPY.verify.title);
    expect(html).not.toContain(FINDING_WHERE_YOU_STAND);
    // The way out is on the step, not on a frame around nothing.
    expect(html).toContain(COPY.signOut);
  });

  it("is shown the enrollment at the root on a first sign-in", () => {
    expect(open("/", "enroll")).toContain(COPY.enroll.title);
  });

  it("is shown the step on a deep link too, and keeps the two public pages", () => {
    expect(open("/f/5b3a1c70-2d9e-4d4b-8a9c-1f2e3d4c5b6a/bank", "verify")).toContain(
      COPY.verify.title,
    );
    const privacy = open("/privacy", "verify");
    expect(privacy).not.toContain(COPY.verify.title);
    expect(privacy).toContain("person@example.test");
  });

  it("reaches the home page once the step is done", () => {
    const html = open("/", "satisfied");
    expect(html).not.toContain(COPY.verify.title);
    expect(html).toContain(FINDING_WHERE_YOU_STAND);
  });
});
