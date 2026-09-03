/**
 * Supermortgage design tokens. THE source of truth.
 *
 * Three tiers, and product code only ever touches the last one:
 *
 *   primitives  raw values named by what they are      grey-600, red-500, serif
 *   semantic    roles that point at primitives          rule → grey-600, accent → red-500
 *   outputs     generated from the semantic tier        border-rule, var(--sm-color-rule)
 *
 * To change the brand red, edit ONE primitive and every button, link, focus
 * ring and the mark follow. To change what red is *for*, edit the semantic
 * map. To add a light theme later, remap the semantic tier under a selector
 * in tokens.css — nothing in a component changes, because no component names
 * a primitive.
 *
 * `tokens.css` is GENERATED from this file:
 *
 *     npm run build  -w @hm/brand     regenerate
 *     npm run verify -w @hm/brand     fail if the two have drifted (runs in CI)
 *
 * `tailwind-preset.mjs` reads this file at config time, so a token added here
 * becomes a utility (bg-*, text-*, border-*) without touching Tailwind config.
 *
 * Every value was read from Doug's prototype at supermortgage.com — see
 * docs/brand.md — except the ones marked `proposed`.
 */

/* ── Primitives ─────────────────────────────────────────────────────────── */

export const primitives = Object.freeze({
  color: Object.freeze({
    black: "#000000",
    white: "#FFFFFF",

    // Greys, light to dark. Steps are named by lightness so a new one can be
    // slotted in without renaming its neighbours.
    "grey-50": "#ECECEC", // the prototype's supporting-copy grey
    "grey-200": "#A3A3A3", // hsl(0 0% 63.9%) — muted foreground
    "grey-400": "#8A8A8A", // proposed: incidental text, still AA on black
    "grey-500": "#6B6B6B", // proposed: a boundary grey that clears 3:1 on black
    "grey-600": "#4A4A4A", // hsl(0 0% 29%) — the prototype's border
    "grey-700": "#3B3B3B", // mobile-menu border
    "grey-800": "#2A2A2A", // the scene's hairline. No role points here; it is
    // marketing scenery (see docs/brand.md), kept so the palette is complete.
    "grey-850": "#1A1A1A", // hsl(0 0% 10%) — secondary / muted fills
    "grey-900": "#111111", // mobile-menu surface
    "grey-950": "#0B0B0E", // the road

    "red-500": "#FF3C2E", // hsl(4 100% 59%) — Super Red. The one accent.
    "red-300": "#FF8A8A", // proposed: error text that is not the accent

    // Borrowed from the pixel world for the two states a product needs and a
    // landing page does not. Scenery colours, promoted deliberately.
    "green-500": "#2FAE4A",
    "gold-500": "#E0A41F",
  }),

  // Nothing here is a web font. The prototype links Inter and never uses it;
  // it renders in Georgia and Helvetica Neue as installed. If a licensed face
  // is adopted, add its @font-face to base.css and change the stack HERE.
  face: Object.freeze({
    serif: 'Georgia, "Times New Roman", serif',
    sans: '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif',
    mono: 'Menlo, Consolas, "Liberation Mono", monospace',
  }),
});

/* ── Semantic ───────────────────────────────────────────────────────────── */

/**
 * Colour roles. Values are primitive names, never hex.
 *
 * The grammar: `ground` is what the page is; `surface` and `raised` sit on
 * it; `ink` writes on it; `rule` divides it; `accent` is what you can act on;
 * `primary` is the one thing you came to do. `ok` / `warn` / `danger` are
 * status and are never the accent — red cannot mean both "press here" and
 * "something is wrong" on the same screen.
 */
export const semantic = Object.freeze({
  color: Object.freeze({
    ground: "black",
    surface: "grey-900",
    raised: "grey-850",

    // Four steps of de-emphasis, and no more. Homestead's palette had seven
    // and its own docs admit some were aliased by accident; on black the
    // useful range runs out below `ink-faint`, which is already at the AA
    // floor for small text.
    ink: "white", // headings, and anything that must be read
    "ink-soft": "grey-50", // body copy
    "ink-muted": "grey-200", // labels, secondary detail
    "ink-faint": "grey-400", // captions, disclaimers, incidental

    rule: "grey-600", // structural: card, nav, toast, menu edges
    "rule-soft": "grey-700", // dividers inside a surface — quieter than its own edge
    "rule-strong": "grey-500", // input boundaries and anything carrying meaning (3:1)

    accent: "red-500",
    "accent-ink": "black",
    primary: "white",
    "primary-ink": "black",

    ok: "green-500",
    warn: "gold-500",
    danger: "red-300",

    focus: "red-500",
  }),

  font: Object.freeze({
    display: "serif", // headlines only, weight 400, never bold
    text: "sans", // everything else
    mono: "mono", // tokens, rates, anything tabular
  }),
});

/* ── Type ───────────────────────────────────────────────────────────────── */

/**
 * One scale. Small steps carry a pixel leading; the large steps carry a
 * unitless one, because a 48px heading that wraps should not inherit a leading
 * computed for 16px. `hero` is the prototype's fluid headline.
 *
 * A size carries NO tracking. The −0.015em is a property of the Georgia
 * display treatment, not of bigness — see `.font-display` in base.css. Tying
 * it to the size instead put display tracking on a sans tabular figure
 * anywhere `text-2xl` was used for a number, which is where this started.
 */
export const type = Object.freeze({
  size: Object.freeze({
    xs: { size: "12px", line: "16px" },
    sm: { size: "14px", line: "20px" },
    base: { size: "16px", line: "24px" },
    lg: { size: "18px", line: "27px" },
    xl: { size: "20px", line: "28px" },
    "2xl": { size: "24px", line: "1.15" },
    "3xl": { size: "30px", line: "1.12" },
    "4xl": { size: "38px", line: "1.05" },
    "5xl": { size: "48px", line: "1.05" },
    hero: { size: "clamp(32px, 5vw, 73px)", line: "1.08" },
  }),
  tracking: Object.freeze({
    display: "-0.015em",
    label: "0.08em",
  }),
  weight: Object.freeze({
    regular: "400",
    medium: "500",
    semibold: "600",
  }),
});

/* ── Shape, depth, motion, measure ──────────────────────────────────────── */

export const radius = Object.freeze({
  sm: "6px", // toast
  md: "8px", // fields, menu items
  lg: "12px", // menus, cards
  pill: "999px", // every button
});

/** The system is flat. These two are the only real shadows in the prototype. */
export const shadow = Object.freeze({
  menu: "0 16px 42px rgba(0, 0, 0, 0.55)",
  toast: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
});

export const motion = Object.freeze({
  ease: Object.freeze({ out: "cubic-bezier(0.16, 1, 0.3, 1)" }),
  duration: Object.freeze({ fast: "150ms", base: "300ms", slow: "800ms" }),
});

export const measure = Object.freeze({
  prose: "62ch",
  hero: "22ch",
  sub: "52ch",
});

/** Spacing rides on Tailwind's default 4px scale, which is the prototype's. */
export const space = Object.freeze({ unit: "4px" });

/** The one breakpoint the prototype uses. Tailwind's `sm` is the same value. */
export const breakpoint = Object.freeze({ mobile: "640px" });

/* ── Resolution helpers ─────────────────────────────────────────────────── */

/** Hex of a semantic colour role, e.g. `resolveColor("accent")` → "#FF3C2E". */
export function resolveColor(role) {
  const primitive = semantic.color[role];
  if (!primitive) throw new Error(`unknown colour role "${role}"`);
  const hex = primitives.color[primitive];
  if (!hex) throw new Error(`colour role "${role}" points at unknown primitive "${primitive}"`);
  return hex;
}

/** "#FF3C2E" → "255 60 46", the channel form Tailwind needs for opacity modifiers. */
export function hexToChannels(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a six-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
