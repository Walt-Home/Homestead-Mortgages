/**
 * Who can open /states, and who gets a door that is not there.
 *
 * The gallery is 34 worked examples with invented figures in them. Whoever is
 * looking at it has to already know that, and the one person guaranteed not to
 * is somebody who came here to borrow money — 34 cards of dollar amounts, on
 * the same domain as their file, behind the same sign-in.
 *
 * The route is asserted through `App` rather than through the predicate alone.
 * A predicate that answers correctly while the JSX still reads the bare flag is
 * exactly the bug this replaced, and nothing but rendering the router can see
 * the difference: a refused /states matches the catch-all, which renders a
 * redirect and no markup at all.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { stateGalleryVisible } from "../lib/auth.js";

/** What `useAuth` answers. Set per render. */
const session = vi.hoisted(() => ({
  value: {} as {
    status: string;
    config: { stateGalleryEnabled?: boolean; demoPersonasEnabled?: boolean } | null;
    user: { persona: { key: string; name: string | null } | null } | null;
    signOut: () => Promise<void>;
  },
}));

// Partial: `App` reads `useAuth` AND `stateGalleryVisible` from this module,
// and mocking the second one away would leave the test asserting itself.
vi.mock("../lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.js")>();
  return { ...actual, useAuth: () => session.value };
});

const REAL_PERSON = { persona: null };
const SAMPLE_BORROWER = { persona: { key: "clean_w2", name: "Dana Reyes" } };

/** The heading only the gallery renders. */
const GALLERY = "Every state, and its words";

function open(
  path: string,
  config: { stateGalleryEnabled?: boolean; demoPersonasEnabled?: boolean } | null,
  user: { persona: { key: string; name: string | null } | null } | null,
): string {
  session.value = { status: "signed-in", config, user, signOut: async () => {} };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const both = { stateGalleryEnabled: true, demoPersonasEnabled: true };

describe("/states", () => {
  it("opens for a signed-in person who is not a sample borrower", () => {
    expect(open("/states", both, REAL_PERSON)).toContain(GALLERY);
  });

  it("is not there for a sample borrower, on the same deployment", () => {
    // The sign-in page hands one of these to anybody who asks for it, so this
    // is the session a stranger on staging is most likely to be holding.
    expect(open("/states", both, SAMPLE_BORROWER)).not.toContain(GALLERY);
  });

  it("is not there where the sample borrowers are not offered", () => {
    // DEMO_PERSONAS off is the closest this product comes to saying "this is
    // the real thing", and STATE_GALLERY alone is what used to be enough.
    expect(
      open("/states", { stateGalleryEnabled: true, demoPersonasEnabled: false }, REAL_PERSON),
    ).not.toContain(GALLERY);
  });

  it("is not there with the flag off", () => {
    expect(
      open("/states", { stateGalleryEnabled: false, demoPersonasEnabled: true }, REAL_PERSON),
    ).not.toContain(GALLERY);
  });

  it("is not there before the config has been read", () => {
    expect(open("/states", null, REAL_PERSON)).not.toContain(GALLERY);
  });
});

describe("stateGalleryVisible", () => {
  it("takes both flags and a session that is nobody's sample", () => {
    expect(stateGalleryVisible(both, REAL_PERSON)).toBe(true);
    expect(stateGalleryVisible(both, SAMPLE_BORROWER)).toBe(false);
    expect(stateGalleryVisible({ stateGalleryEnabled: true }, REAL_PERSON)).toBe(false);
    expect(stateGalleryVisible({ demoPersonasEnabled: true }, REAL_PERSON)).toBe(false);
    expect(stateGalleryVisible(null, REAL_PERSON)).toBe(false);
  });

  it("says no when nobody is signed in", () => {
    // The signed-out tree has no /states route in it either. Both answers
    // matter: this one is what a signed-out `App` would ask if it ever did.
    expect(stateGalleryVisible(both, null)).toBe(false);
  });
});
