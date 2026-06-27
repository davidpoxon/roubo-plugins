import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  // Inject CJS compatibility shims so bundled CJS packages work correctly in ESM context.
  banner: {
    js: "import { createRequire as __cjsRequire } from 'module';\nimport { fileURLToPath as __cjsFileURLToPath } from 'url';\nimport { dirname as __cjsDirname } from 'path';\nconst require = __cjsRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);",
  },
  // The packaged Electron app ships no plugin node_modules, so any dep omitted here becomes an
  // ERR_MODULE_NOT_FOUND at boot. Keep this list in sync with package.json dependencies.
  noExternal: [
    "@roubo/plugin-sdk",
    "@roubo/shared",
    "@roubo/shared-github",
    "vscode-jsonrpc",
    "octokit",
  ],
});
