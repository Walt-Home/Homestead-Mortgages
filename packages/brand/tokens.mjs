/**
 * Supermortgage design tokens. THE source of truth.
 *
 * Three tiers, and product code only ever touches the last one:
 *
 *   primitives  raw values named by what they are      gray-600, red-500, serif
 *   semantic    roles that point at primitives          rule → gray-600, accent → red-500
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
 * Every color is one Doug's Apply product ships — `prototype-theme.css` and
 * `apply.css` in doug-ludlow/Supermortgage, the paper-and-ink set that has
 * been its default since 15 September 2026 — except where a comment says the
 * value he ships fails a contrast floor and names the one used instead. The
 * faces, sizes, radii and motion are still the 3 September reading of the
 * marketing prototype; see docs/brand.md for both.
 */

/* ── Primitives ─────────────────────────────────────────────────────────── */

export const primitives = Object.freeze({
  color: Object.freeze({
    white: "#FFFFFF",
    black: "#000000", // No role points here. The mark is still drawn on it for
    // marketing, and the brand page shows that rendering.

    // Paper and its grays, light to dark. Named by lightness so a step can be
    // slotted in without renaming its neighbors. The comment on each is the
    // custom property it is in Doug's Apply product.
    "paper-50": "#FCFCFC", // --paper: the ground
    "paper-100": "#F4F4F4", // --subtle, --desktop: a raised block; the desk behind the sheet
    "paper-200": "#EBEBEB", // --selected: a chosen row
    "gray-200": "#E5E5E5", // --line: dividers inside a surface
    "gray-250": "#DEDEDE", // --card-line: the edge of a card
    "gray-300": "#BABABC", // --field-line. 1.9:1 on paper — decorative only, never a
    // boundary that carries meaning; WCAG 1.4.11 wants 3:1, see rule-strong.
    "gray-400": "#A2A2A4", // --quiet. 2.5:1 on paper — icons and hairlines, never text.
    "gray-500": "#747479", // his dark set's --choice-line. The lightest gray that clears
    // 3:1 on paper AND on white, so it is the input boundary here.
    "gray-600": "#68686A", // --muted: labels, captions. 5.4:1, AA.
    "gray-800": "#2A2A2A", // the street scene's hairline. No role points here.
    "gray-900": "#080808", // --text: everything that must be read.
    "gray-950": "#0B0B0E", // the street scene's road. No role points here.

    "red-500": "#BF242B", // --accent, --button: Super Red, deepened for paper. The one accent.
    "red-600": "#AA1D24", // --accent-pressed
    "red-800": "#842128", // --accent-text: red that reads as text on paper, 9.2:1
    "red-100": "#F9E1E2", // --accent-soft: the wash behind a selected red thing

    // Status. His set carries a positive and a caution. The caution he ships,
    // #B76A00, is 4.0:1 on paper and the floor is 4.5, so this is the darker
    // one from his earlier light set. The green is the pixel world's, kept for
    // the street scene; the status green is his.
    "green-500": "#2FAE4A", // the street's grass. No role points here.
    "green-600": "#1F7A45", // --sm-positive
    "gold-700": "#A35A00", // --sm-caution, the earlier light set's
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
 * Color roles. Values are primitive names, never hex.
 *
 * The grammar: `ground` is what the page is; `surface` and `raised` sit on
 * it; `ink` writes on it; `rule` divides it; `accent` is what you can act on;
 * `primary` is the one thing you came to do. `ok` / `warn` / `danger` are
 * status and are never the accent — red cannot mean both "press here" and
 * "something is wrong" on the same screen.
 */
export const semantic = Object.freeze({
  color: Object.freeze({
    ground: "paper-50",
    surface: "white",
    raised: "paper-100",

    // Four roles, two values. Doug's theme has three text steps — text,
    // muted, quiet — and the third is 2.5:1 on paper, which the floors
    // refuse. So `ink` and `ink-soft` are his text and `ink-muted` and
    // `ink-faint` are his muted. The roles stay distinct so a dark set can
    // spread them out again; on paper they collapse, and that is his palette
    // rather than a loss.
    ink: "gray-900", // headings, and anything that must be read
    "ink-soft": "gray-900", // body copy
    "ink-muted": "gray-600", // labels, secondary detail
    "ink-faint": "gray-600", // captions, disclaimers, incidental

    rule: "gray-250", // structural: card, nav, toast, menu edges
    "rule-soft": "gray-200", // dividers inside a surface — quieter than its own edge
    "rule-strong": "gray-500", // input boundaries and anything carrying meaning (3:1)

    accent: "red-500",
    "accent-ink": "white",
    // The one primary button a screen gets is the red one, as in his Apply
    // product. There is no white button on paper, so `primary` and `accent`
    // are the same red and `.super-btn-primary` and `.super-btn-solid` render
    // alike.
    primary: "red-500",
    "primary-ink": "white",

    ok: "green-600",
    warn: "gold-700",
    // A darker shade of the accent rather than another hue: his palette has
    // no error color that is not red. The primitives differ, which is what
    // the test holds. Whether a shade split is enough of a split is open —
    // docs/brand.md, open question 9.
    danger: "red-800",

    focus: "gray-900", // his --sm-focus: the ring is ink, not the accent
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

/** Hex of a semantic color role, e.g. `resolveColor("accent")` → "#FF3C2E". */
export function resolveColor(role) {
  const primitive = semantic.color[role];
  if (!primitive) throw new Error(`unknown color role "${role}"`);
  const hex = primitives.color[primitive];
  if (!hex) throw new Error(`color role "${role}" points at unknown primitive "${primitive}"`);
  return hex;
}

/** "#FF3C2E" → "255 60 46", the channel form Tailwind needs for opacity modifiers. */
export function hexToChannels(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a six-digit hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
