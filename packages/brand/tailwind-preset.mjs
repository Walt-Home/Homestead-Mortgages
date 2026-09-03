/**
 * Tailwind preset, derived from tokens.mjs at config time.
 *
 * Every utility resolves to a CSS custom property, never to a literal, so a
 * change in tokens.mjs (after `npm run build -w @hm/brand`) reaches every
 * `bg-ground`, `text-ink`, `font-display` and `rounded-pill` without a
 * rebuild of the config — and a runtime theme override in CSS reaches them
 * too.
 *
 * `theme.colors`, `fontFamily`, `fontSize`, `borderRadius` and `boxShadow`
 * are REPLACED, not extended. That is deliberate: there is no `text-gray-500`
 * and no `font-sans` to fall back on, so a colour or face that is not a token
 * cannot reach a component by accident. Add the token; the utility appears.
 */

import { measure, motion, radius, semantic, shadow, type } from "./tokens.mjs";

/**
 * "ink-soft" → colors.ink.soft, "ink" → colors.ink.DEFAULT.
 * Gives `text-ink` and `text-ink-soft` from one flat token list.
 */
function nested(names, valueFor) {
  const out = {};
  for (const name of names) {
    const [head, ...rest] = name.split("-");
    const key = rest.length ? rest.join("-") : "DEFAULT";
    out[head] ??= {};
    out[head][key] = valueFor(name);
  }
  // A group with only DEFAULT collapses to a string, which Tailwind prefers.
  for (const [head, group] of Object.entries(out)) {
    const keys = Object.keys(group);
    if (keys.length === 1 && keys[0] === "DEFAULT") out[head] = group.DEFAULT;
  }
  return out;
}

const colors = {
  transparent: "transparent",
  current: "currentColor",
  inherit: "inherit",
  ...nested(
    Object.keys(semantic.color),
    (role) => `rgb(var(--sm-color-${role}-rgb) / <alpha-value>)`,
  ),
};

const fontFamily = Object.fromEntries(
  Object.keys(semantic.font).map((role) => [role, `var(--sm-font-${role})`]),
);

// Size and leading only. Tracking belongs to the face, not the size — see the
// note in tokens.mjs and the `.font-display` rule in base.css.
const fontSize = Object.fromEntries(
  Object.keys(type.size).map((step) => [
    step,
    [`var(--sm-text-${step})`, { lineHeight: `var(--sm-leading-${step})` }],
  ]),
);

const borderRadius = {
  none: "0",
  ...Object.fromEntries(Object.keys(radius).map((name) => [name, `var(--sm-radius-${name})`])),
  full: "9999px",
};

const boxShadow = {
  none: "none",
  ...Object.fromEntries(Object.keys(shadow).map((name) => [name, `var(--sm-shadow-${name})`])),
};

/** @type {import('tailwindcss').Config} */
export const preset = {
  theme: {
    colors,
    fontFamily,
    fontSize,
    borderRadius,
    boxShadow,
    // A bare `border` is a rule, not currentColor.
    borderColor: ({ theme }) => ({ ...theme("colors"), DEFAULT: theme("colors.rule.DEFAULT") }),
    ringColor: ({ theme }) => ({ ...theme("colors"), DEFAULT: theme("colors.focus") }),
    ringOffsetColor: ({ theme }) => theme("colors"),
    extend: {
      letterSpacing: Object.fromEntries(
        Object.keys(type.tracking).map((name) => [name, `var(--sm-tracking-${name})`]),
      ),
      transitionTimingFunction: Object.fromEntries(
        Object.keys(motion.ease).map((name) => [name, `var(--sm-ease-${name})`]),
      ),
      transitionDuration: Object.fromEntries(
        Object.keys(motion.duration).map((name) => [name, `var(--sm-duration-${name})`]),
      ),
      maxWidth: Object.fromEntries(
        Object.keys(measure).map((name) => [`measure-${name}`, `var(--sm-measure-${name})`]),
      ),
    },
  },
};

export default preset;
