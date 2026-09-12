/**
 * One flat config for the whole monorepo.
 *
 * There was never an eslint config in this repo — the dependencies were
 * installed and `eslint .` was wired into every workspace's `lint` script, but
 * nothing was ever authored, so `npm run lint` has failed on main since the
 * beginning and CI never ran it. See docs/decisions.md.
 *
 * ESLint 10 searches upward from the working directory, so each workspace's
 * `eslint .` finds this file and every package is linted by the same rules.
 * Globs here are relative to this file, which is the repo root.
 *
 * Formatting is NOT eslint's job. Prettier owns it, and `eslint-config-prettier`
 * is last in the array so any rule the two would fight over is switched off.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      // Generated from data/v1-build.csv by scripts/build-requirements.mjs and
      // committed. `npm run requirements:verify` is what guards it; linting it
      // would only create pressure to hand-edit a file that must never be
      // hand-edited.
      "packages/requirements/src/generated.ts",
      // Generated from packages/brand/tokens.mjs, same reasoning.
      "packages/brand/tokens.css",
      // Generated from Fannie Mae's DU specification by scripts/build-du.mjs,
      // same reasoning. `npm run du:verify` is what guards these.
      "packages/du/src/generated/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // A leading underscore means "this parameter is required by a signature I
      // do not control, and I am deliberately not using it". The codebase
      // already writes it that way and it is load-bearing in at least one
      // place: Express recognises error middleware ONLY by its four-argument
      // arity, so `errorHandler(err, _req, res, _next)` must keep `_next` or
      // error handling silently stops being error handling.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },

  // Node-side code: everything that is not the browser app.
  {
    files: ["**/*.{ts,mts,js,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },

  // The browser app.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat["recommended-latest"],
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      // The classic hook rules above — rules-of-hooks and exhaustive-deps —
      // stay as errors. These three are the React Compiler rules that arrived
      // in eslint-plugin-react-hooks v7, and they are OFF for now.
      //
      // Not because they are wrong. They found eight real things, and every
      // one is a deliberate pattern whose compiler-safe rewrite is a
      // behavioural change: reading sessionStorage into state on mount
      // (PlaidReturnPage), prefilling a form from fetched data
      // (PropertyLoanPage), resuming a bank session and a self-scheduling poll
      // (BankPage), and the latest-ref pattern behind the Plaid callbacks
      // (PlaidLink). Those are the OAuth-return and polling paths — the
      // hardest screens in the app to exercise and the worst ones to break.
      //
      // Turning lint on for the first time and refactoring the bank flow are
      // two changes, and coupling them means the second one ships unreviewed
      // inside the first. Adopt these deliberately, one file at a time, with
      // the flow walked end to end each time.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
    },
  },

  prettier,
);
