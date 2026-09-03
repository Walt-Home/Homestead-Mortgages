/**
 * The brand's own regression tests.
 *
 * Two kinds of failure these catch: a token edit that quietly makes text
 * unreadable (the contrast floors), and a token edit that was not propagated
 * (tokens.css stale, or a role pointing at a primitive that no longer exists).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { primitives, resolveColor, semantic } from "../tokens.mjs";
import { render } from "../scripts/build.mjs";
import { preset } from "../tailwind-preset.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.x contrast ratio between two semantic roles. */
function contrast(a, b) {
  const la = luminance(resolveColor(a));
  const lb = luminance(resolveColor(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("token integrity", () => {
  it("every color role points at a primitive that exists", () => {
    for (const role of Object.keys(semantic.color)) {
      expect(() => resolveColor(role)).not.toThrow();
    }
  });

  it("every font role points at a face that exists", () => {
    for (const [role, face] of Object.entries(semantic.font)) {
      expect(primitives.face[face], `font role ${role}`).toBeTypeOf("string");
    }
  });

  it("no semantic role holds a raw value", () => {
    for (const [role, value] of Object.entries(semantic.color)) {
      expect(value, `${role} must name a primitive, not a color`).not.toMatch(/^#/);
    }
  });

  it("tokens.css is generated from the current tokens.mjs", () => {
    const onDisk = readFileSync(resolve(here, "../tokens.css"), "utf8");
    expect(onDisk).toBe(render());
  });
});

describe("contrast floors (WCAG 2.x)", () => {
  const floors = [
    // [foreground, background, minimum, why]
    ["ink", "ground", 7, "body text, AAA"],
    ["ink-soft", "ground", 7, "supporting copy, AAA"],
    ["ink-muted", "ground", 4.5, "labels and secondary detail, AA"],
    ["ink-faint", "ground", 4.5, "captions and disclaimers, AA"],
    ["ink-faint", "raised", 4.5, "captions on a raised surface, AA"],
    ["ink", "surface", 7, "text inside a field"],
    ["ink-muted", "surface", 4.5, "placeholder inside a field"],
    ["accent", "ground", 4.5, "outline buttons and links"],
    ["accent-ink", "accent", 4.5, "text on a solid accent button"],
    ["primary-ink", "primary", 4.5, "text on the primary button"],
    ["ok", "ground", 4.5, "status text"],
    ["warn", "ground", 4.5, "status text"],
    ["danger", "ground", 4.5, "error text"],
    ["rule-strong", "ground", 3, "input boundary, WCAG 1.4.11"],
    ["rule-strong", "surface", 3, "input boundary against its own fill"],
  ];

  for (const [fg, bg, min, why] of floors) {
    it(`${fg} on ${bg} ≥ ${min}:1 (${why})`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
    });
  }

  it("the accent and the danger color are not the same primitive", () => {
    expect(semantic.color.accent).not.toBe(semantic.color.danger);
  });
});

describe("tailwind preset", () => {
  it("exposes every color role as an opacity-capable utility", () => {
    const flat = JSON.stringify(preset.theme.colors);
    for (const role of Object.keys(semantic.color)) {
      expect(flat).toContain(`rgb(var(--sm-color-${role}-rgb) / <alpha-value>)`);
    }
  });

  it("exposes no color that is not a token", () => {
    const heads = Object.keys(preset.theme.colors).filter(
      (k) => !["transparent", "current", "inherit"].includes(k),
    );
    const roles = new Set(Object.keys(semantic.color).map((r) => r.split("-")[0]));
    for (const head of heads) expect(roles.has(head), head).toBe(true);
  });

  it("exposes only the token faces", () => {
    expect(Object.keys(preset.theme.fontFamily).sort()).toEqual(Object.keys(semantic.font).sort());
  });
});
