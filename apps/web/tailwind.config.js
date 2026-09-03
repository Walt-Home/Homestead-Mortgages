import preset from "@hm/brand/tailwind";

/**
 * The theme lives in @hm/brand, not here.
 *
 * The preset REPLACES Tailwind's colour, font, radius and shadow scales with
 * the Supermortgage tokens, so `text-gray-500` and `font-sans` do not exist.
 * That is the point: a value that is not a token cannot reach a component by
 * accident. If you need one, add it to packages/brand/tokens.mjs and run
 * `npm run build -w @hm/brand`.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  plugins: [],
};
