# Supermortgage brand and design system

Draft 0.1, 3 September 2026. Read from Doug's Replit prototype at
<https://supermortgage.com/> — the CSS it ships, the DOM it renders, and the
copy in its bundle. Nothing here was invented except where a line is marked
**proposed**. The visual companion to this document is the brand page
artifact: <https://claude.ai/code/artifact/5a56ee8d-b28f-4aad-931b-3311e6faee56>.

Supermortgage is the consumer brand this repo's borrower flow will eventually
wear. The tokens in `apps/web/src/index.css` today are Homestead's warm
cream, olive and gold; they are the opposite of this system and nothing maps
one-to-one. See [Adopting this in `apps/web`](#adopting-this-in-appsweb).

## The idea

Supermortgage makes one claim, in plain words, at the top of every page: the
greatest mortgage ever offered.

The claim is carried by two registers that must never blur. The words are set
in a classical serif on solid black, the register of a bank's front door. The
world underneath is pixel art: bright houses, yard signs, a moving van, people
walking their dogs. The serif is the promise. The pixels are the people it is
for.

Everything else follows from that split:

- Black is the ground and never a "surface color".
- Red is spent only on things a borrower can act on.
- One display face, one text face, neither of them a web font.
- Nothing has a shadow.
- The only things that move are the people on the street and the rate on the
  sign.

Personality, as three contrasts:

| Is        | Is not    | Which means                                                                                                                |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Confident | Loud      | One superlative, once, at the top. After that, declarative sentences and numbers.                                          |
| Plain     | Corporate | "Log in", "Sign up", "Join the Waitlist". No "Get started", no "Explore solutions".                                        |
| Playful   | Childish  | The pixel world is detailed and calm: lit windows, a parked van, a SOLD sign. Never bouncing, never cute for its own sake. |

## Logo

### The mark

A house drawn on a 12 × 12 unit grid in Super Red with a doorway cut out of
the body. It is an inline SVG of `<rect>`s with `shape-rendering="crispEdges"`.
The same drawing appears on the side of the moving van in the street scene,
which is the only place the logo shows up outside the nav.

| Context                   | Size                               |
| ------------------------- | ---------------------------------- |
| Desktop nav               | 26 px                              |
| Mobile nav (≤ 640 px)     | 22 px, and that is the minimum     |
| Large (marketing, social) | whole multiples of 12: 48, 96, 144 |

Rules: crisp edges always, never anti-aliased, never any color but red (or
white on a red field). Scale to whole multiples where you can so the grid
stays square.

### The wordmark

SUPERMORTGAGE in caps, geometric sans, with SUPER in a light weight and
MORTGAGE in a heavy one. The weight change is the point: the ordinary product
is the bold part. Aspect ratio 350 : 29.

The prototype ships it as a white PNG, 700 × 58, base64-inlined in the page.
There is no dark-on-light version; the brand page's black-on-white is a CSS
`invert(1)` placeholder. **Redraw as SVG** is open question 3.

### The lockup

| Context     | Mark  | Gap   | Wordmark                          |
| ----------- | ----- | ----- | --------------------------------- |
| Desktop nav | 26 px | 10 px | height 20 px, width auto          |
| Mobile nav  | 22 px | 8 px  | width `min(190px, 100vw − 118px)` |

Clear space: one mark-width on every side (**proposed**; the prototype does
not define it).

In prose the name is **Supermortgage**. One word, capital S. Never
SuperMortgage, never all caps outside the wordmark. The prototype's own copy
is consistent about this ("Thanks for your interest in Supermortgage!").

## Color

### Core

| Name      | Hex       | HSL token                              | Role                                                               |
| --------- | --------- | -------------------------------------- | ------------------------------------------------------------------ |
| Black     | `#000000` | `--background: 0 0% 0%`                | The ground. Every page, every surface. Pure black, not near-black. |
| White     | `#FFFFFF` | `--foreground: 0 0% 100%`, `--primary` | Type, the wordmark, the one primary CTA.                           |
| Super Red | `#FF3C2E` | `--accent: 4 100% 59%`, `--ring`       | The mark, account buttons, links, focus rings.                     |

### Grays

| Name     | Hex       | Token                                            | Role                                           |
| -------- | --------- | ------------------------------------------------ | ---------------------------------------------- |
| Sub      | `#ECECEC` | (literal in `.super-sub`)                        | Supporting copy under a headline.              |
| Muted    | `#A3A3A3` | `--muted-foreground: 0 0% 63.9%`                 | Labels, captions.                              |
| Rule     | `#4A4A4A` | `--border`, `--input`, `--card-border: 0 0% 29%` | Nav bottom border, toast border, input border. |
| Hairline | `#2A2A2A` | (literal in `.super-street-wrap`)                | Dividers inside the scene. Decorative only.    |
| Surface  | `#1A1A1A` | `--muted`, `--secondary: 0 0% 10%`               | Secondary fills.                               |
| Menu     | `#111111` | (literal)                                        | The mobile menu, with a `#3B3B3B` border.      |
| Road     | `#0B0B0E` | (literal)                                        | Footer strip; dashes in `#3A3A42`.             |

### Three reds

The prototype has three reds that are meant to be one:

| Where                                      | Hex                           |
| ------------------------------------------ | ----------------------------- |
| CSS accent token                           | `#FF3C2E` (`hsl(4 100% 59%)`) |
| Every pixel-art sprite, including the mark | `#FF3B30`                     |
| `favicon.svg`                              | `#FF3C00`                     |

They differ by a few points and a side-by-side shows it. **The token wins.**
Redraw the sprites and the favicon to `#FF3C2E`. Open question 1.

### The pixel world

The street uses a second, wider palette that never touches the interface.
Flat, saturated, lit from inside. Most-used fills, from the sprite SVGs:

| Group                | Hex                               |
| -------------------- | --------------------------------- |
| Teal / shade         | `#12C2B0` / `#0E8F83`             |
| Grass / shade / edge | `#2FAE4A` / `#153A1C` / `#1D7C33` |
| Window / glow        | `#FFE08A` / `#FFF3D6`             |
| Sky / glass          | `#7FE3FF` / `#BDF1FF`             |
| Blue                 | `#2A6FD6`, `#3A7BD5`              |
| Purple / shade       | `#7B52D6` / `#5B3AA8`             |
| Orange, gold, brick  | `#FF8A3D`, `#E0A41F`, `#C22F14`   |
| Tan, cream           | `#C98A4B`, `#E8E2D6`              |
| Night, roof, asphalt | `#2E2E44`, `#2C2C33`, `#3A3A42`   |
| Wood, skin           | `#7A4A21`, `#FFCF9F` / `#B07047`  |

The shadcn chart tokens (`--chart-1..5`) are the library defaults and are not
part of the brand.

### Contrast (WCAG 2.x, computed)

| Pair                                       | Ratio    | Verdict                                                                                                       |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| White on Black                             | 21.0 : 1 | AAA                                                                                                           |
| Sub on Black                               | 17.8 : 1 | AAA                                                                                                           |
| Muted on Black                             | 8.3 : 1  | AAA                                                                                                           |
| Super Red on Black (outline button, links) | 5.9 : 1  | AA text, AAA large                                                                                            |
| Black on Super Red (solid button)          | 5.9 : 1  | AA text                                                                                                       |
| White on Super Red                         | 3.5 : 1  | Large text only                                                                                               |
| Super Red on White                         | 3.5 : 1  | Large text only. Red links on a light surface fail.                                                           |
| Rule `#4A4A4A` on Black                    | 2.4 : 1  | Fine for decorative rules. Below the 3 : 1 required for an input border or any boundary that carries meaning. |

## Typography

### Stacks

| Role        | Stack                                                       | Fallback reality                        |
| ----------- | ----------------------------------------------------------- | --------------------------------------- |
| Display     | `Georgia, "Times New Roman", serif`                         | Times on Windows, Noto Serif on Android |
| Body and UI | `"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif` | Arial on Windows, Roboto on Android     |
| Mono        | `Menlo, monospace`                                          | tokens, rates, anything tabular         |

**Nothing is a web font.** The prototype links Inter (400–700) from Google
Fonts and never uses it; every element resolves to Georgia or Helvetica Neue.
That is either a deliberate system-font strategy (instant, no layout shift,
looks different per OS) or a leftover. Open question 2.

### Display

Georgia, regular weight only. Tracking −0.015em. Leading 1.08 (1.05 on
mobile). Never bold, never small, never used for anything that is not a
headline. Italic is unused in the prototype.

|                                | Size                                     | Measure |
| ------------------------------ | ---------------------------------------- | ------- |
| Hero, desktop                  | `clamp(32px, 5vw, 73px)` (64 px at 1280) | 22ch    |
| Hero, mobile (≤ 640)           | `clamp(31px, 8.5vw, 38px)`               | 22ch    |
| Section heading (**proposed**) | 30 / 1.12                                |         |

### Text

| Role                 | Size / weight                          | Notes                                     |
| -------------------- | -------------------------------------- | ----------------------------------------- |
| Sub                  | `clamp(15px, 1.3vw, 18px)` / 400 / 1.5 | color Sub `#ECECEC`; 52ch, 34ch on mobile |
| Body                 | 16 / 400 / 1.5                         |                                           |
| CTA                  | 17 / 600                               |                                           |
| Button               | 14 / 500 / 20px                        |                                           |
| Toast title          | 14 / 600                               |                                           |
| Toast body           | 14 / 400 at 90 % opacity               |                                           |
| Label (**proposed**) | 12 / 500, +0.08em, uppercase, Muted    | the prototype has no type below 14 px     |
| Mono                 | 13 / 1.5                               |                                           |

## Space and shape

Base unit 4 px (`--spacing: .25rem`). Nothing is on a half unit.

| Where           | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Nav padding     | 20 × 40 desktop, 18 × 20 mobile; 82 px tall (78 mobile) |
| Nav gap         | 24 px (16 mobile); logo gap 10 (8)                      |
| Hero stack gap  | 36 px (32 mobile)                                       |
| Hero padding    | 56 top, 24 sides, 32 bottom (34 / 24 / 30 mobile)       |
| Street prop gap | 34 px                                                   |

Radius:

| Value   | Use                              |
| ------- | -------------------------------- |
| 6 px    | toast                            |
| 8 px    | menu item                        |
| 12 px   | mobile menu                      |
| 22 px   | nav buttons (pill at 41 px tall) |
| 36 px   | CTA (pill at 65 px tall)         |
| `.5rem` | `--radius`, shadcn defaults only |

Rules and elevation:

| Use               | Value                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Nav bottom border | `1px solid #4A4A4A`                                                                            |
| Street divider    | `1px solid #2A2A2A`                                                                            |
| Grass top edge    | `2px solid #2FAE4A` over a 10 px `#153A1C` band and a 4 px `#101014` band                      |
| Button border     | `1.5px solid` Super Red                                                                        |
| Shadow tokens     | all eight (`--shadow-2xs` … `--shadow-2xl`) resolve to fully transparent. Flat by declaration. |
| Mobile menu       | `0 16px 42px rgba(0,0,0,.55)` — the one real shadow                                            |
| Toast             | shadcn `shadow-lg`, barely visible on black                                                    |

## Components

Seven pieces, all in the prototype today. Class names are Doug's (`.super-*`).

**Navigation bar** (`.super-nav`). Logo lockup left, spacer, Log in
(outline), Sign up (solid), hamburger. Under 640 px the two auth buttons hide
and move into the mobile menu. The hamburger stays on desktop and, in the
prototype, only raises a toast. Bars are 28 × 2 white with a 7 px gap; open
state fades the middle bar and rotates the outer two ±45° after a 9 px
translate, 300 ms.

**Buttons.**

| Variant                        | Fill      | Text      | Border           | Type     | Padding                                | Radius | Hover         | Active    |
| ------------------------------ | --------- | --------- | ---------------- | -------- | -------------------------------------- | ------ | ------------- | --------- |
| Outline (`.super-btn-outline`) | none      | Super Red | 1.5 px Super Red | 14 / 500 | 9 × 20                                 | 22     | 10 % red wash | scale .95 |
| Solid (`.super-btn-solid`)     | Super Red | Black     | 1.5 px Super Red | 14 / 500 | 9 × 20                                 | 22     | 90 % red      | scale .95 |
| CTA (`.super-cta`)             | White     | Black     | none             | 17 / 600 | 20 × 44 (18 × 30 mobile, max 276 wide) | 36     | 90 % white    | scale .95 |

There is exactly one white button per screen and it is the thing you came to
do. Red is for the account actions around it.

**Text link** (`.super-learn-more`). Super Red, 500, no underline until hover,
`white-space: nowrap`. Focus-visible: 2 px red outline, 2 px offset.

**Hamburger** (`.super-hamburger`). Hover 80 % opacity, press scale .95.

**Mobile menu** (`.super-mobile-menu`, ≤ 640 only). Absolute under the nav,
16 px from the right. `#111` with `1px #3B3B3B`, 12 px radius, 8 px padding.
Items 12 × 14, 8 px radius; hover/focus turns the label red on
`rgba(255,255,255,.06)`.

**Toast** (shadcn/Radix defaults as rendered). Black, `1px #4A4A4A`, 6 px
radius, 24 px padding with 32 on the right for the close. Bottom-right and at
most 420 px wide on desktop; full-width at the top on mobile. Title 14 / 600,
body 14 / 400 at 90 %. Copy has two beats: what happened, then a human
sentence.

**Street scene** (`.super-scene`). See [The pixel world](#the-pixel-world).

## Motion

| What                     | Timing                                                         | Note                                                                             |
| ------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Entrance `slideUp`       | 800 ms `cubic-bezier(.16, 1, .3, 1)`, stagger 0 / 100 / 200 ms | h1, sub, CTA rise 20 px while fading in. Nothing else animates in.               |
| Button press             | scale .95, 150 ms                                              | all buttons and the hamburger                                                    |
| Button hover             | 150 ms                                                         | outline +10 % red wash; solid → 90 %; CTA → 90 % white; hamburger → 80 % opacity |
| Hamburger fold           | 300 ms                                                         |                                                                                  |
| Walkers                  | 46 s →, 58 s ←, jogger 24 s →                                  | linear, infinite, negative delays so the street is populated on load             |
| Cars                     | 13 s →, 17 s ←                                                 | wheel hubs alternate frames every 180 ms                                         |
| Moving van               | 34 s; parked from 36 % to 62 % at 34vw                         | the one story beat: it arrives, stops for nine seconds, drives off               |
| Walk cycle               | 550 ms `step-end`, 2 frames (jogger 300 ms)                    | two SVG groups toggled by `visibility`, no tweening                              |
| Rate sign                | 3 s ease-in-out                                                | the yard sign's arrow fades in and out: the rate dropping, on loop               |
| `prefers-reduced-motion` | actors `display: none`, sign held at opacity 1                 | the entrance still runs in the prototype; **proposed**: disable it too           |

Keyframes, verbatim:

```css
@keyframes slideUp {
  0% {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes go-right {
  0% {
    transform: translate(-160px);
  }
  to {
    transform: translate(calc(100vw + 160px));
  }
}
@keyframes go-left {
  0% {
    transform: translate(calc(100vw + 160px)) scaleX(-1);
  }
  to {
    transform: translate(-160px) scaleX(-1);
  }
}
@keyframes frameA {
  0%,
  49% {
    visibility: visible;
  }
  50%,
  to {
    visibility: hidden;
  }
}
@keyframes frameB {
  0%,
  49% {
    visibility: hidden;
  }
  50%,
  to {
    visibility: visible;
  }
}
@keyframes van-trip {
  0% {
    transform: translate(-240px);
  }
  36% {
    transform: translate(34vw);
  }
  62% {
    transform: translate(34vw);
  }
  to {
    transform: translate(calc(100vw + 240px));
  }
}
@keyframes rate-pulse {
  0%,
  to {
    opacity: 0;
  }
  20%,
  65% {
    opacity: 1;
  }
}
```

## The pixel world

Fifteen static props (eleven buildings, two trees, two shrubs) and six actors
(two walkers, a jogger, two cars, a moving van). Every sprite is an inline SVG
of unit `<rect>`s on an integer grid: a house is about 60 units wide, a person
10 × 21, a car 34 × 14. They are authored at 4 × their grid size (`width` and
`height` attributes) and the street is then `zoom: .62` (`.54` on mobile), so
one unit lands at roughly 2.5 px. On mobile every even-numbered prop is
hidden (`svg:nth-child(2n)`).

Rules:

- **Flat fills, no outlines.** Shading is a second, darker fill of the same
  hue. No gradients, strokes, or anti-aliasing (`shape-rendering: crispEdges;
image-rendering: pixelated`).
- **Every house is lit.** One warm window (`#FFE08A`) per building. It is
  night on this street and everyone is home.
- **Signs carry the plot.** Yard signs say SOLD and REFI; the three that pulse
  (`.super-rate-pulse`) show a rate falling. That is the product, drawn.
- **The mark lives in-world.** The moving van wears the red house.
- **People are in scale.** Adults are 21 units to a 44-unit house. Keep the
  ratio when adding actors.
- **Calm, not cute.** Walkers walk. Nothing bounces, waves, or looks at the
  camera.

## Voice

The prototype's copy, in full:

| Where | Copy                                                                                         |
| ----- | -------------------------------------------------------------------------------------------- |
| Hero  | The Greatest Mortgage Ever Offered                                                           |
| Sub   | Automatically refinances when interest rates drop, with lowest rates guaranteed · Learn more |
| CTA   | Join the Waitlist                                                                            |
| Nav   | Log in · Sign up                                                                             |
| Toast | **Waitlist joined** — Thanks for your interest in Supermortgage!                             |
| Toast | **Menu opened** — Mobile navigation would appear here.                                       |

Principles:

- **One superlative, at the top.** The headline is allowed to be the
  greatest. Everything after it is a fact with a number in it or a thing the
  borrower can do.
- **Title case for the promise, sentence case for the work.** Headline and
  CTA take title case; toasts, menus and body copy take sentence case.
- **Buttons are verbs.** Log in, Sign up, Join the Waitlist. Never "Get
  started", never "Submit".
- **Confirmations have two beats.** A title that says what happened, then one
  warm sentence. The exclamation mark is spent there and nowhere else.
- **The name is one word.** Supermortgage. The wordmark shouts; the copy does
  not.

## Open questions

1. **One red.** Token, sprites and favicon disagree. The token wins; redraw
   the other two.
2. **Web fonts or system fonts.** Inter is linked and unused. Either the brand
   is Georgia and Helvetica Neue as installed and the link goes, or a licensed
   serif and sans get chosen and loaded.
3. **A vector wordmark.** It is a white PNG today: cannot be recolored,
   blurs at 3×, has no dark-on-light version.
4. **Light surfaces.** The prototype has no light mode. The borrower flow has
   forms, documents and PDFs. Decide whether those live on black, or whether
   the product side of the brand has a paper surface, and what red does there
   (3.5 : 1 on white).
5. **Input borders.** `--input` is the same 29 % gray as the rules, 2.4 : 1 on
   black. Inputs need a lighter border or a filled field.
6. **The guarantee.** "Lowest rates guaranteed" and "automatically
   refinances" are advertising claims on a mortgage product. Before this copy
   ships, someone who knows the rules has to say what disclosures ride with
   it, and the system needs a disclosure style so they are not an
   afterthought.
7. **Metadata.** `<meta name="description">` still reads "built on Replit";
   there is no OG image. The street would make a good one.
8. **Relationship to the Homestead tokens.** See below.

## How the brand reaches a screen

The system is code, in `packages/brand`, and `apps/web` wears it. See that
package's README for the full API; the short version:

**To change a color or a font, edit `packages/brand/tokens.mjs` and run
`npm run brand:build`.** Everything follows: the generated custom properties,
the Tailwind utilities, and the `.super-*` components. `npm run brand:verify`
runs in CI and fails if the generated CSS was not rebuilt.

Three tiers. Primitives are named for what they are (`red-500`, `gray-600`,
`serif`), semantic roles for what they are for (`accent`, `rule`, `display`),
and the outputs are generated. Product code names roles only, which is what
makes a re-theme a one-file edit rather than a search across 6,500 lines.

Tailwind's default palette is replaced rather than extended, so `text-gray-500`
and `font-sans` do not exist and a non-token value cannot reach a component.
The contrast floors in this document are enforced as tests: a token edit that
drops body text, a label, a status color or an input border below its WCAG
minimum fails the build.

### What the migration changed, and what it could not

The four borrower screens, the three branches and every shared component now
render on these tokens. Two things are worth knowing.

**Seven levels of de-emphasis became four.** Homestead's palette had `ink`,
`ink-editorial`, `ink-prose`, `ink-soft`, `muted`, `meta` and `subtle`, and its
own documentation admitted some were aliased by accident. On black the useful
range runs out sooner, so the ramp is `ink` → `ink-soft` → `ink-muted` →
`ink-faint`, and `ink-faint` already sits at the AA floor for small text.

**Arbitrary type sizes are gone.** The app carried eighteen distinct
`text-[13px]`-style values; they are now on the scale. A handful of sizes moved
by a pixel or two as a result, which is the cost of having a scale at all.

### Still open

The prototype had no light surface, and neither does this: the product is
black throughout. That remains open question 4 above, and it now has a
concrete shape — every form, notice, table and figure in the borrower flow has
a dark treatment, so a light mode would be a second value set for the semantic
tier rather than a redesign. `tokens.mjs` is arranged for that: remap the
roles under a selector and no component changes.

The mark is drawn in `apps/web/src/components/Wordmark.tsx` rather than
loaded from the prototype's PNG, because the PNG is white-only and cannot take
the accent color. Replacing it with the real vector wordmark, when it exists,
is a change to that one component.
