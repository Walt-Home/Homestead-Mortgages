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
        canvas: "var(--hm-canvas)",
        surface: "var(--hm-surface)",
        app: "var(--hm-app)",
        raised: "var(--hm-raised)",
        inset: "var(--hm-inset)",
        hover: "var(--hm-hover)",
        ink: {
          DEFAULT: "var(--hm-ink)",
          editorial: "var(--hm-ink-editorial)",
          prose: "var(--hm-ink-prose)",
          soft: "var(--hm-ink-soft)",
        },
        muted: "var(--hm-text-muted)",
        meta: "var(--hm-meta)",
        subtle: "var(--hm-subtle)",
        line: {
          DEFAULT: "var(--hm-border)",
          light: "var(--hm-border-light)",
          form: "var(--hm-border-form)",
          strong: "var(--hm-border-strong)",
        },
        olive: {
          DEFAULT: "var(--hm-olive)",
          hover: "var(--hm-olive-hover)",
          chat: "var(--hm-olive-chat)",
          tint: "var(--hm-olive-tint)",
          light: "var(--hm-olive-light)",
          border: "var(--hm-olive-border)",
        },
        gold: {
          DEFAULT: "var(--hm-gold)",
          hover: "var(--hm-gold-hover)",
          fill: "var(--hm-gold-fill)",
          border: "var(--hm-gold-border)",
        },
        error: "var(--hm-error)",
        danger: "var(--hm-danger)",
        notice: {
          bg: "var(--hm-notice-bg)",
          border: "var(--hm-notice-border)",
        },
      },
      fontFamily: {
        ui: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        brand: ["Manrope", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        prose: ["Source Serif 4", "Georgia", "serif"],
      },
      borderRadius: {
        form: "var(--hm-r-form)",
        control: "var(--hm-r-control)",
        row: "var(--hm-r-row)",
        card: "var(--hm-r-card)",
        pill: "var(--hm-r-pill)",
      },
      boxShadow: {
        card: "var(--hm-shadow-card)",
        cta: "var(--hm-shadow-cta)",
      },
    },
  },
  plugins: [],
};
