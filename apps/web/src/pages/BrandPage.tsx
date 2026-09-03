/**
 * /brand — the shareable one-pager: colors, fonts, logo.
 *
 * Public, and deliberately outside the auth gate, because the people who most
 * need it are the ones without an account: Doug, whoever is drawing the next
 * screen, whoever is writing an email template.
 *
 * Every value is READ FROM THE LIVE STYLESHEET rather than typed in here.
 * `getComputedStyle` resolves the whole `--sm-color-accent → --sm-red-500`
 * chain, so a swatch shows what the app is actually painting with. A brand
 * page that can disagree with the product is worse than no brand page, and
 * hardcoding the hexes is exactly how that happens.
 *
 * Note the class names below are written out in full rather than built from
 * the role — `text-2xl`, not `text-${step}`. Tailwind scans this file as text,
 * so an interpolated class name generates no CSS at all.
 *
 * Keep this page to color, type and the mark. The full identity — voice,
 * motion, the pixel world, open questions — lives in docs/brand.md, and the
 * package API in packages/brand/README.md.
 */

import { useEffect, useState } from "react";
import { Lockup, Mark, PRODUCT_NAME, Wordmark } from "../components/Wordmark.js";

/** Semantic color roles, grouped the way somebody picking one would think. */
const COLOR_GROUPS: { title: string; note: string; roles: [string, string][] }[] = [
  {
    title: "Surfaces",
    note: "Black is the ground, never a surface color. Two steps up from it, and no further.",
    roles: [
      ["ground", "The page itself"],
      ["surface", "Inputs and menus"],
      ["raised", "Notices and hover washes"],
    ],
  },
  {
    title: "Text",
    note: "Four steps of de-emphasis, and no more. Below faint, black stops being readable.",
    roles: [
      ["ink", "Headings, and anything that must be read"],
      ["ink-soft", "Body copy"],
      ["ink-muted", "Labels and secondary detail"],
      ["ink-faint", "Captions and disclaimers"],
    ],
  },
  {
    title: "Rules",
    note: "Structural edges, quiet dividers, and boundaries that carry meaning.",
    roles: [
      ["rule", "Card, nav and toast edges"],
      ["rule-soft", "Dividers inside a surface"],
      ["rule-strong", "Input boundaries"],
    ],
  },
  {
    title: "Action",
    note: "Red is what you can act on. White is the one thing you came to do.",
    roles: [
      ["accent", "Links, secondary buttons, the mark"],
      ["accent-ink", "Text on a solid red button"],
      ["primary", "The single primary button a screen gets"],
      ["primary-ink", "Text on that button"],
      ["focus", "The focus ring"],
    ],
  },
  {
    title: "Status",
    note: "State, never decoration. Red is the accent, so errors get a color of their own.",
    roles: [
      ["ok", "Verified, connected, done"],
      ["warn", "Needs attention"],
      ["danger", "Something went wrong"],
    ],
  },
];

/**
 * The four sanctioned color treatments.
 *
 * Named with primitives rather than semantic roles on purpose. This page
 * documents the palette, and the system has no role for "a sheet of white
 * paper" — that is open question 4 in docs/brand.md. Everywhere other than
 * this page, a component names a role.
 */
const LOGO_VARIANTS = [
  {
    name: "White on black",
    fg: "var(--sm-white)",
    bg: "var(--sm-black)",
    use: "The default. Any product surface.",
  },
  {
    name: "Red on black",
    fg: "var(--sm-red-500)",
    bg: "var(--sm-black)",
    use: "The nav, and the mark on the moving van.",
  },
  {
    name: "Black on white",
    fg: "var(--sm-black)",
    bg: "var(--sm-white)",
    use: "Print, and anything that lands on paper.",
  },
  {
    name: "Red on white",
    fg: "var(--sm-red-500)",
    bg: "var(--sm-white)",
    use: "Sparingly. 3.5 : 1, so never small.",
  },
];

const FACES = [
  {
    role: "display",
    face: "font-display",
    use: "Headlines only. Regular weight, never bold.",
    sample: "The Supermortgage",
  },
  {
    role: "text",
    face: "font-text",
    use: "Body copy, labels, buttons — everything else.",
    sample: "Connect your bank",
  },
  {
    role: "mono",
    face: "font-mono",
    use: "Rates, tokens, anything that lines up in a column.",
    sample: "6.125%",
  },
];

/** Written out, not interpolated, so Tailwind emits them. */
const SCALE = [
  { step: "hero", size: "text-hero" },
  { step: "5xl", size: "text-5xl" },
  { step: "4xl", size: "text-4xl" },
  { step: "3xl", size: "text-3xl" },
  { step: "2xl", size: "text-2xl" },
  { step: "xl", size: "text-xl" },
  { step: "lg", size: "text-lg" },
  { step: "base", size: "text-base" },
  { step: "sm", size: "text-sm" },
  { step: "xs", size: "text-xs" },
];

const COLOR_PROPS = COLOR_GROUPS.flatMap((g) => g.roles.map(([role]) => `--sm-color-${role}`));
const TYPE_PROPS = [
  ...FACES.map((f) => `--sm-font-${f.role}`),
  ...SCALE.map((s) => `--sm-text-${s.step}`),
];

/** Reads custom properties off :root once the stylesheet is live. */
function useTokens(properties: string[]): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(properties.map((p) => [p, style.getPropertyValue(p).trim()])));
    // The argument is a module-level constant. Depending on it would re-run
    // this on every render and loop through setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return values;
}

export function BrandPage() {
  const colors = useTokens(COLOR_PROPS);
  const type = useTokens(TYPE_PROPS);

  return (
    <div className="mx-auto max-w-2xl px-5 py-14 sm:px-6 sm:py-20">
      <p className="super-eyebrow text-accent">{PRODUCT_NAME}</p>
      <h1 className="mt-3 font-display text-4xl text-ink sm:text-5xl">Brand</h1>
      <p className="mt-5 max-w-measure-prose text-lg text-ink-soft">
        A serious promise, told in a friendly world. The words are a classical serif on solid black.
        Everything you can act on is one red.
      </p>
      <p className="mt-4 max-w-measure-prose text-base text-ink-muted">
        Every value below is read from the stylesheet this page is rendered with, so it cannot drift
        from the product.
      </p>

      {/* ── Logo ─────────────────────────────────────────────────────────── */}
      <Section title="Logo">
        <h3 className="text-base font-medium text-ink">The mark</h3>
        <p className="mt-1 max-w-measure-prose text-sm text-ink-muted">
          A house on a 12 × 12 grid. The lit doorway is a hole, not black paint, so it takes
          whatever is behind it.
        </p>
        <div className="super-card mt-3 flex flex-wrap items-end gap-8">
          <Specimen label="96px">
            <Mark size={96} className="text-accent" />
          </Specimen>
          <Specimen label="48px">
            <Mark size={48} className="text-accent" />
          </Specimen>
          <Specimen label="26px · nav">
            <Mark size={26} className="text-accent" />
          </Specimen>
          <Specimen label="22px · minimum">
            <Mark size={22} className="text-accent" />
          </Specimen>
        </div>

        <h3 className="mt-8 text-base font-medium text-ink">Wordmark and lockup</h3>
        <p className="mt-1 max-w-measure-prose text-sm text-ink-muted">
          SUPER light, MORTGAGE heavy — the ordinary half is the bold one.
        </p>
        <div className="super-card mt-3 flex flex-col gap-6">
          <Specimen label="wordmark">
            <Wordmark className="text-xl text-accent" />
          </Specimen>
          <Specimen label="lockup">
            <Lockup size={26} className="text-accent" />
          </Specimen>
        </div>

        <h3 className="mt-8 text-base font-medium text-ink">Color</h3>
        <p className="mt-1 max-w-measure-prose text-sm text-ink-muted">
          Four treatments, and no others. Every piece paints with{" "}
          <code className="font-mono">currentColor</code>, so these are the same three components
          with the text color changed.
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {LOGO_VARIANTS.map((variant) => (
            <li key={variant.name} className="overflow-hidden rounded-lg border border-rule">
              <div
                className="flex flex-col items-center justify-center gap-5 px-5 py-8"
                style={{ background: variant.bg, color: variant.fg }}
              >
                <Mark size={44} />
                <Wordmark className="text-lg" />
                <Lockup size={22} />
              </div>
              <div className="border-t border-rule px-4 py-3">
                <p className="text-sm text-ink">{variant.name}</p>
                <p className="mt-0.5 text-sm text-ink-muted">{variant.use}</p>
              </div>
            </li>
          ))}
        </ul>

        <h3 className="mt-8 text-base font-medium text-ink">Rules</h3>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-ink-soft">
          <li>· Crisp edges, whole multiples, never anti-aliased and never re-drawn by hand.</li>
          <li>· Only the four treatments above. No gradient, no outline, no second color.</li>
          <li>· Never below 22px, where the doorway stops resolving.</li>
          <li>· Clear space of one mark-width on every side.</li>
          <li>· In prose the name is one word, capital S: {PRODUCT_NAME}.</li>
        </ul>
      </Section>

      {/* ── Color ───────────────────────────────────────────────────────── */}
      <Section title="Color">
        {COLOR_GROUPS.map((group) => (
          <div key={group.title} className="mt-8 first:mt-0">
            <h3 className="text-base font-medium text-ink">{group.title}</h3>
            <p className="mt-1 max-w-measure-prose text-sm text-ink-muted">{group.note}</p>
            <ul className="mt-3 overflow-hidden rounded-md border border-rule">
              {group.roles.map(([role, use]) => (
                <li
                  key={role}
                  className="flex items-center gap-4 border-b border-rule-soft px-4 py-3 last:border-b-0"
                >
                  <span
                    aria-hidden="true"
                    className="h-9 w-9 shrink-0 rounded-md border border-rule-strong"
                    style={{ background: `var(--sm-color-${role})` }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{role}</span>
                    <span className="block text-sm text-ink-muted">{use}</span>
                  </span>
                  <code className="super-figure shrink-0 font-mono text-sm uppercase text-ink-muted">
                    {colors[`--sm-color-${role}`] || "—"}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>

      {/* ── Type ─────────────────────────────────────────────────────────── */}
      <Section title="Type">
        <p className="max-w-measure-prose text-sm text-ink-muted">
          No web fonts. These are the faces as installed, so the page paints instantly and shifts
          nothing — and looks a little different on Windows and Android, which is the trade.
        </p>

        <div className="super-card mt-3">
          <p className="font-display text-3xl text-ink">{FACES[0]!.sample}</p>
          <p className="mt-3 text-sm text-ink-soft">{FACES[0]!.use}</p>
          <code className="mt-1 block font-mono text-sm text-ink-muted">
            {type["--sm-font-display"] || "—"}
          </code>
        </div>
        <div className="super-card mt-3">
          <p className="font-text text-3xl text-ink">{FACES[1]!.sample}</p>
          <p className="mt-3 text-sm text-ink-soft">{FACES[1]!.use}</p>
          <code className="mt-1 block font-mono text-sm text-ink-muted">
            {type["--sm-font-text"] || "—"}
          </code>
        </div>
        <div className="super-card mt-3">
          <p className="font-mono text-3xl text-ink">{FACES[2]!.sample}</p>
          <p className="mt-3 text-sm text-ink-soft">{FACES[2]!.use}</p>
          <code className="mt-1 block font-mono text-sm text-ink-muted">
            {type["--sm-font-mono"] || "—"}
          </code>
        </div>

        <h3 className="mt-8 text-base font-medium text-ink">Scale</h3>
        <p className="mt-1 max-w-measure-prose text-sm text-ink-muted">
          One scale, and nothing off it. Tracking belongs to the display face, not to the size.
        </p>
        <ul className="mt-3 flex flex-col">
          {SCALE.map(({ step, size }) => (
            <li
              key={step}
              className="flex items-baseline gap-4 border-b border-rule-soft py-3 last:border-b-0"
            >
              <code className="w-14 shrink-0 font-mono text-sm text-ink-muted">{step}</code>
              <span className={`min-w-0 flex-1 truncate font-display text-ink ${size}`}>
                Ever Offered
              </span>
              <code className="super-figure shrink-0 font-mono text-sm text-ink-muted">
                {type[`--sm-text-${step}`] || "—"}
              </code>
            </li>
          ))}
        </ul>
      </Section>

      <p className="mt-14 border-t border-rule-soft pt-5 text-sm text-ink-faint">
        To change any of this, edit <code className="font-mono">packages/brand/tokens.mjs</code> and
        run <code className="font-mono">npm run brand:build</code>. The full identity — voice,
        motion, the pixel world — is in <code className="font-mono">docs/brand.md</code>.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="mb-4 font-display text-2xl text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="m-0 flex flex-col items-center gap-2">
      {children}
      <figcaption className="font-mono text-sm text-ink-muted">{label}</figcaption>
    </figure>
  );
}
