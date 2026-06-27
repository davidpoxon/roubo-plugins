import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist", "**/node_modules", "**/coverage"] },

  // Base TypeScript config for all plugin source: Node.js environment
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    linterOptions: {
      noInlineConfig: true,
    },
    languageOptions: {
      globals: globals.node,
    },
  },

  // JS/MJS/CJS scripts: Node.js environment
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Disable ESLint rules that conflict with Prettier — must be last
  prettier,
);
