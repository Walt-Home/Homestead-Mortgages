# @hm/brand

The Supermortgage design system as code: tokens, a Tailwind preset, and the
component CSS. The identity itself is documented in `docs/brand.md`; this
package is how it reaches a screen.

## Change a color or a font

Edit **`tokens.mjs`**, then:

```bash
npm run build -w @hm/brand
```

That is the whole procedure. `tokens.css` is regenerated, the Tailwind preset
reads the same file, and every `bg-ground`, `text-accent`, `font-display`,
`var(--sm-color-rule)` and `.super-btn` follows. `npm test` fails if a change
drops any text below its contrast floor, and `npm run verify -w @hm/brand`
(run in CI) fails if `tokens.css` was not regenerated.

| To change…                 | Edit                          | Example                                |
| -------------------------- | ----------------------------- | -------------------------------------- |
| what the brand red _is_    | `primitives.color["red-500"]` | `#FF3C2E` → `#E8352A`                  |
| what red is _used for_     | `semantic.color.accent`       | `"red-500"` → `"teal-500"`             |
| the display face           | `primitives.face.serif`       | `Georgia, …` → `"Tiempos", Georgia, …` |
| which face is the display  | `semantic.font.display`       | `"serif"` → `"sans"`                   |
| a type size or its leading | `type.size`                   | `"2xl": { size: "24px", … }`           |
| a radius, shadow, easing   | `radius`, `shadow`, `motion`  |                                        |

If a licensed web font is adopted, put its `@font-face` in `base.css` and
change the stack in `tokens.mjs`. Nothing else moves.

## The three tiers

```
primitives   gray-600, red-500, serif          named by what they ARE
semantic     rule → gray-600, accent → red-500   named by what they are FOR
outputs      border-rule, --sm-color-rule        generated; never hand-edited
```

Product code uses the semantic tier only. There is no `text-gray-500` and no
`font-sans` in the Tailwind theme, so a value that is not a token cannot reach
a component. Add the token and the utility exists.

## What the package exports

| Import                     | What it is                                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| `@hm/brand`                | `tokens.mjs`: the source of truth, plus `resolveColor()` and `hexToChannels()` |
| `@hm/brand/tailwind`       | the Tailwind preset. `presets: [preset]` in `tailwind.config.js`               |
| `@hm/brand/tokens.css`     | generated custom properties on `:root`                                         |
| `@hm/brand/base.css`       | element defaults in `@layer base`                                              |
| `@hm/brand/components.css` | `.super-*` components in `@layer components`                                   |
| `@hm/brand/assets/*`       | the mark, the wordmark, the favicon                                            |

Stylesheet order in a consumer (`apps/web/src/index.css` is the reference):

```css
@import "@hm/brand/tokens.css";
@import "tailwindcss/base";
@import "@hm/brand/base.css";
@import "tailwindcss/components";
@import "@hm/brand/components.css";
@import "tailwindcss/utilities";
```

## Naming

CSS custom properties are `--sm-*`. Component classes are `.super-*`, the
prefix Doug's prototype uses, so markup ports between the marketing site and
the product without renaming.

| Semantic color                     | Role                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `ground`                           | the page. Black. Never a "surface color"                |
| `surface`, `raised`                | one and two steps up: fields, menus, hover washes       |
| `ink`, `ink-soft`, `ink-muted`     | text, supporting copy, labels                           |
| `rule`, `rule-soft`, `rule-strong` | structural divider, hairline, input boundary            |
| `accent` / `accent-ink`            | what you can act on: links, secondary buttons, the mark |
| `primary` / `primary-ink`          | the one white button a screen gets                      |
| `ok`, `warn`, `danger`             | status. Never the accent                                |
| `focus`                            | the ring                                                |

Components: `.super-btn` (+ `-primary`, `-outline`, `-solid`, `-danger`,
`-ghost`), `.super-cta`, `.super-link`, `.super-link-quiet`, `.super-label`,
`.super-input`, `.super-card`, `.super-notice` (+ `-ok`, `-warn`, `-danger`),
`.super-pill` (+ status), `.super-figure`, `.super-eyebrow`, `.super-h1`,
`.super-sub`, `.super-toast`.

## Rules

1. Never hand-edit `tokens.css`. `npm run verify -w @hm/brand` will catch it.
2. Components name roles, not primitives. `text-accent`, never `text-red-500`
   (there is no `text-red-500`).
3. Display type is Georgia at regular weight. `font-display` forces 400.
4. One `.super-btn-primary` per screen. Red is for the actions around it.
5. `danger` is never the same primitive as `accent`; the tests enforce it.
6. Status colors (`ok`, `warn`, `danger`) are for state. Decoration uses grays.
