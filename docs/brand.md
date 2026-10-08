# Supermortgage brand and design system

Draft 0.1, 3 September 2026. Read from Doug's Replit prototype at
<https://supermortgage.com/> — the CSS it ships, the DOM it renders, and the
copy in its bundle. Nothing here was invented except where a line is marked
**proposed**. The visual companion to this document is the brand page
artifact: <https://claude.ai/code/artifact/5a56ee8d-b28f-4aad-931b-3311e6faee56>.

Revised 21 September 2026: the **color** section now reads from the
paper-and-ink set Doug's Apply product ships in doug-ludlow/Supermortgage
(`apps/borrower/app/prototype-theme.css`, `components/apply/apply.css`), his
default since 15 September. The faces, the type scale, space, shape and
motion are still the 3 September reading; the black ground survives only
under the street scene.

Supermortgage is the consumer brand this repo's borrower flow will eventually
wear. The tokens in `apps/web/src/index.css` today are Homestead's warm
cream, olive and gold; they are the opposite of this system and nothing maps
one-to-one. See [Adopting this in `apps/web`](#adopting-this-in-appsweb).

## The idea

Supermortgage makes one claim, in plain words, at the top of every page: the
greatest mortgage ever offered.

The claim is carried by the words, set in a classical serif, the register of
a bank's front door, under a wordmark and nothing else. Until 8 October 2026
a second register sat beneath them — a pixel-art street of bright houses,
yard signs and a moving van, with a pixel house for a mark — and both were
retired that day (Joe: "we're moving away from that"). supermortgage.com
carries the wordmark over photography now; the product carries it on paper.

Everything else follows from that split:

- Paper is the ground and never a "surface color"; black is the street's.
- Red is spent only on things a borrower can act on.
- One display face, one text face, neither of them a web font.
- Nothing has a shadow.
- The only things that move are the people on the street and the rate on the
  sign.

Personality, as three contrasts:

| Is        | Is not    | Which means                                                                                   |
| --------- | --------- | --------------------------------------------------------------------------------------------- |
| Confident | Loud      | One superlative, once, at the top. After that, declarative sentences and numbers.             |
| Plain     | Corporate | "Log in", "Sign up", "Join the Waitlist". No "Get started", no "Explore solutions".           |
| Playful   | Childish  | Warm in the words, never in the furniture. Nothing bounces, nothing is cute for its own sake. |

## Logo

### The mark

Retired 8 October 2026. There is no mark: the house on its 12 × 12 grid is
gone from the nav, the favicon and the brand page, and the street it rode on
is gone with it. The logo is the wordmark alone, which is what
supermortgage.com carries.

### The wordmark

SUPERMORTGAGE in caps, geometric sans, with SUPER in a heavy weight and
MORTGAGE in a light one — corrected 8 October 2026 against the live artwork,
which is the reverse of the first prototype's weights. Aspect ratio
2061 : 172.

supermortgage.com ships it as a dark-gray PNG wrapped in an SVG and recolors
it with a CSS filter where it sits on a photograph. The product's nav sets it
in type (`Wordmark.tsx`) so it can take any text color. **Redraw as vector**
is still open question 3. The favicon is the site's: SUPER over MORTGAGE,
dark on white, a PNG.

### The lockup

The wordmark, at the nav's size, with nothing beside it. Clear space of one
cap-height on every side.

In prose the name is **Supermortgage**. One word, capital S. Never
SuperMortgage, never all caps outside the wordmark. The prototype's own copy
is consistent about this ("Thanks for your interest in Supermortgage!").

## Color

The product's palette is Doug's paper-and-ink set. Each row names the custom
property it is in his Apply product and the primitive it is in
`packages/brand/tokens.mjs`; a value he ships that fails a contrast floor is
called out, with the one used instead.

### Core

| Name      | Hex       | Doug's property        | Role                                                                                                                              |
| --------- | --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Paper     | `#FCFCFC` | `--paper`              | The ground. Every page. Not white: white is one step up.                                                                          |
| White     | `#FFFFFF` | `--surface`            | Fields, cards, the sheet.                                                                                                         |
| Text      | `#080808` | `--text`               | Headings and body copy alike. His theme has one text color, so `ink` and `ink-soft` are the same value.                           |
| Super Red | `#BF242B` | `--accent`, `--button` | The mark, every button, links, the current step. Deeper than the marketing prototype's `#FF3C2E` because it has to read on paper. |

### Grays

| Hex       | Doug's property          | Token       | Role                                                                                           |
| --------- | ------------------------ | ----------- | ---------------------------------------------------------------------------------------------- |
| `#F4F4F4` | `--subtle`, `--desktop`  | `paper-100` | A raised block; the desk behind the sheet.                                                     |
| `#EBEBEB` | `--selected`             | `paper-200` | A chosen row.                                                                                  |
| `#E5E5E5` | `--line`                 | `gray-200`  | Dividers inside a surface (`rule-soft`).                                                       |
| `#DEDEDE` | `--card-line`            | `gray-250`  | The edge of a card (`rule`).                                                                   |
| `#BABABC` | `--field-line`           | `gray-300`  | His input border. 1.9 : 1, so here it is decorative only.                                      |
| `#A2A2A4` | `--quiet`                | `gray-400`  | His third text step. 2.5 : 1, so here it is icons and hairlines, never text.                   |
| `#747479` | dark set `--choice-line` | `gray-500`  | The input boundary (`rule-strong`): the lightest gray that clears 3 : 1 on paper and on white. |
| `#68686A` | `--muted`                | `gray-600`  | Labels and captions (`ink-muted`, and `ink-faint` until a dark set spreads them). 5.4 : 1.     |

### The reds

| Hex       | Doug's property    | Token     | Role                                              |
| --------- | ------------------ | --------- | ------------------------------------------------- |
| `#BF242B` | `--accent`         | `red-500` | The accent and the primary button.                |
| `#AA1D24` | `--accent-pressed` | `red-600` | Pressed.                                          |
| `#842128` | `--accent-text`    | `red-800` | Red as text, 9.2 : 1. The error color (`danger`). |
| `#F9E1E2` | `--accent-soft`    | `red-100` | The wash behind a selected red thing.             |

The marketing prototype's three reds (`#FF3C2E` in its CSS, `#FF3B30` in the
sprites, `#FF3C00` in the favicon) are now a question about the street scene
and the favicon only. Open question 1 stands for those.

### Status

| Hex       | Token       | Role                                                                                                                           |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `#1F7A45` | `green-600` | `ok`. Doug's `--sm-positive`.                                                                                                  |
| `#A35A00` | `gold-700`  | `warn`. The caution his Apply skin ships, `#B76A00`, is 4.0 : 1 on paper; this is the one from his earlier light set, 5.1 : 1. |
| `#842128` | `red-800`   | `danger`. A shade of the accent, not another hue. Open question 9.                                                             |

### The dark set

Doug's theme carries a second value set under `data-theme="dark"`: paper
`#151516`, surface `#222224`, text `#F5F5F5`, muted `#ADADB2`, quiet
`#94949A`, line `#38383B`, accent `#EF858B` on the ground and `#BF242B` for
the button. Every pair in it clears the floors except the input boundary on
a surface (2.9 : 1). It is not built here yet. `tokens.mjs` is arranged so
that it is a second semantic map under a selector and no component changes;
that is also where `ink-soft` and `ink-faint` get their own values back.

### The pixel world

Retired 8 October 2026. The street — fifteen props, six actors, every sprite
a grid of unit rectangles, the moving van wearing the mark — came off the
landing page, `StreetScene.tsx` and `scene.css` were deleted, and nothing in
the system animates now. If a world returns, it is photography, as on
supermortgage.com.

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

1. ~~**One red.**~~ Closed 8 October 2026: the sprites and the house favicon
   are gone, so the token is the one red.
2. **Web fonts or system fonts.** Inter is linked and unused. Either the brand
   is Georgia and Helvetica Neue as installed and the link goes, or a licensed
   serif and sans get chosen and loaded.
3. **A vector wordmark.** It is a white PNG today: cannot be recolored,
   blurs at 3×, has no dark-on-light version.
4. ~~**Light surfaces.**~~ Decided 21 September 2026: the product is on
   paper, with Doug's deeper red (`#BF242B`, 5.8 : 1). What is open now is the
   dark set — see "The dark set" above.
5. ~~**Input borders.**~~ Decided with 4: `rule-strong` is `#747479`, the
   lightest gray that clears 3 : 1 on paper and on white. Doug's own field
   border (`#BABABC`) does not, and stays decorative.
6. **The guarantee.** "Lowest rates guaranteed" and "automatically
   refinances" are advertising claims on a mortgage product. Before this copy
   ships, someone who knows the rules has to say what disclosures ride with
   it, and the system needs a disclosure style so they are not an
   afterthought. Half of it is settled: the guarantee is off the page. This
   product has no lock desk, no lock record and nothing that enforces a quote's
   expiry, so a guaranteed rate was not an unreviewed claim but a false one,
   and `RATE_COMMITMENT` in `copy-rules.ts` now fails the build over it. The
   table above still records the prototype's line, because that is what the
   prototype says. "Automatically refinances" is the half still open.
7. **Metadata.** `<meta name="description">` still reads "built on Replit";
   there is no OG image. The street would make a good one.
8. **Relationship to the Homestead tokens.** See below.
9. **Red for errors.** Doug's palette has no error color that is not red:
   `danger` is `#842128`, a darker shade of the `#BF242B` accent. The test
   that keeps them separate primitives passes, but the rule it guards —
   red cannot mean both "press here" and "something is wrong" — is now held
   by shade alone. Decide whether that is enough, or whether the error color
   gets its own hue and Doug's set gains one.

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

The product is on paper now, and the second value set is the dark one —
Doug's `data-theme="dark"` set, listed under "The dark set" above. Every form,
notice, table and figure in the borrower flow renders on the semantic roles,
so the dark set is a remap of those roles under a selector rather than a
redesign. `tokens.mjs` is arranged for that; nothing renders it yet.

The mark is drawn in `apps/web/src/components/Wordmark.tsx` rather than
loaded from the prototype's PNG, because the PNG is white-only and cannot take
the accent color. Replacing it with the real vector wordmark, when it exists,
is a change to that one component.
