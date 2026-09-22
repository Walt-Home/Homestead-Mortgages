/**
 * The console's theme, mapped from src/theme.css.
 *
 * Tailwind's palette, faces, radii and shadows are REPLACED, not extended:
 * there is no `text-gray-500` and no `shadow-md` here, so a value that is not
 * a console token cannot reach a component by accident. Spacing stays on the
 * default 4px scale.
 *
 * @type {import('tailwindcss').Config}
 */
const channel = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      canvas: channel("canvas"),
      surface: channel("surface"),
      "surface-2": channel("surface-2"),
      "surface-3": channel("surface-3"),
      line: channel("line"),
      "line-2": channel("line-2"),
      "line-3": channel("line-3"),
      fg: channel("fg"),
      "fg-2": channel("fg-2"),
      "fg-3": channel("fg-3"),
      accent: channel("accent"),
      "accent-fg": channel("accent-fg"),
      "accent-soft": channel("accent-soft"),
      ok: channel("ok"),
      "ok-soft": channel("ok-soft"),
      warn: channel("warn"),
      "warn-soft": channel("warn-soft"),
      danger: channel("danger"),
      "danger-soft": channel("danger-soft"),
      info: channel("info"),
      "info-soft": channel("info-soft"),
      focus: channel("focus"),
    },
    fontFamily: {
      sans: "var(--font-sans)",
      mono: "var(--font-mono)",
    },
    fontSize: {
      xs: ["11px", { lineHeight: "16px" }],
      sm: ["13px", { lineHeight: "18px" }],
      base: ["14px", { lineHeight: "20px" }],
      md: ["15px", { lineHeight: "22px" }],
      lg: ["17px", { lineHeight: "24px" }],
      xl: ["20px", { lineHeight: "28px" }],
      "2xl": ["24px", { lineHeight: "30px" }],
      "3xl": ["30px", { lineHeight: "36px" }],
      "4xl": ["38px", { lineHeight: "44px" }],
    },
    borderRadius: {
      none: "0",
      sm: "var(--radius-sm)",
      DEFAULT: "var(--radius-md)",
      md: "var(--radius-md)",
      lg: "var(--radius-lg)",
      xl: "var(--radius-xl)",
      full: "9999px",
    },
    boxShadow: {
      none: "none",
      card: "var(--shadow-card)",
      menu: "var(--shadow-menu)",
      sheet: "var(--shadow-sheet)",
    },
    extend: {
      transitionTimingFunction: { out: "var(--ease-out)" },
      screens: { xs: "480px" },
    },
  },
  plugins: [],
};
