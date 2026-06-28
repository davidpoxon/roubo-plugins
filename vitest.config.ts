import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Plugin tests import transitively from `@roubo/shared-github`, which only
      // exists at `plugins/_shared-github/dist/` after a build step. CI runs
      // tests directly off `npm ci` (no build), so we alias the package to its
      // source entry to keep the test job hermetic.
      "@roubo/shared-github": fileURLToPath(
        new URL("./plugins/_shared-github/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    restoreMocks: true,
    include: ["plugins/**/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["plugins/**/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__tests__/**", "**/dist/**", "**/node_modules/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
