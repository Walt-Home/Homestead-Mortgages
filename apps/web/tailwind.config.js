/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Ported from Homestead's `--hs-*` token block. Only the palette and the
      // type stacks came across — the component layer did not, deliberately.
      // Homestead's own docs/design-system.md is candid that eleven of its
      // fourteen kit components have no consumers, and this product needs
      // form surfaces that kit never had.
      colors: {
        canvas: "var(--sm-canvas)",
        surface: "var(--sm-surface)",
        app: "var(--sm-app)",
        raised: "var(--sm-raised)",
        inset: "var(--sm-inset)",
        hover: "var(--sm-hover)",
        ink: {
          DEFAULT: "var(--sm-ink)",
          editorial: "var(--sm-ink-editorial)",
          prose: "var(--sm-ink-prose)",
          soft: "var(--sm-ink-soft)",
        },
        muted: "var(--sm-text-muted)",
        meta: "var(--sm-meta)",
        subtle: "var(--sm-subtle)",
        line: {
          DEFAULT: "var(--sm-border)",
          light: "var(--sm-border-light)",
          form: "var(--sm-border-form)",
          strong: "var(--sm-border-strong)",
        },
        olive: {
          DEFAULT: "var(--sm-olive)",
          hover: "var(--sm-olive-hover)",
          chat: "var(--sm-olive-chat)",
          tint: "var(--sm-olive-tint)",
          light: "var(--sm-olive-light)",
          border: "var(--sm-olive-border)",
        },
        gold: {
          DEFAULT: "var(--sm-gold)",
          hover: "var(--sm-gold-hover)",
          fill: "var(--sm-gold-fill)",
          border: "var(--sm-gold-border)",
        },
        error: "var(--sm-error)",
        danger: "var(--sm-danger)",
        notice: {
          bg: "var(--sm-notice-bg)",
          border: "var(--sm-notice-border)",
        },
      },
      fontFamily: {
        ui: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        brand: ["Manrope", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        prose: ["Source Serif 4", "Georgia", "serif"],
      },
      borderRadius: {
        form: "var(--sm-r-form)",
        control: "var(--sm-r-control)",
        row: "var(--sm-r-row)",
        card: "var(--sm-r-card)",
        pill: "var(--sm-r-pill)",
      },
      boxShadow: {
        card: "var(--sm-shadow-card)",
        cta: "var(--sm-shadow-cta)",
      },
    },
  },
  plugins: [],
};
