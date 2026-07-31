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
  banner: {
    js: "import { createRequire as __cjsRequire } from 'module';\nimport { fileURLToPath as __cjsFileURLToPath } from 'url';\nimport { dirname as __cjsDirname } from 'path';\nconst require = __cjsRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);",
  },
  noExternal: ["@roubo/plugin-sdk", "@roubo/shared", "vscode-jsonrpc"],
});
