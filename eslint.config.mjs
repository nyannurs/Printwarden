// The linter's rules (npm run lint): mistakes a reader can miss, such as a name used but
// never defined or imported, a variable set and never read, code that can never run.
// Style is left alone.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["vendor/**", "node_modules/**", "_build/*/**", "_lab/**", "_testfiles/**"] },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-shadow-restricted-names": "error",
      "no-use-before-define": ["error", { functions: false, classes: false, variables: false }],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  { // the app, in the window
    files: ["app/**/*.js", "tests/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.browser },
  },
  { // its workers
    files: ["app/**/*-worker.js"],
    languageOptions: { globals: globals.worker },
  },
  { // the desktop shell and the development tools
    files: ["_build/*.mjs", "tools/**/*.mjs", "*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
  },
  {
    files: ["_build/*.cjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs", globals: globals.node },
  },
];
