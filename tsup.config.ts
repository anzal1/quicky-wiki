import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node\nimport{createRequire}from"module";const require=createRequire(import.meta.url);',
  },
  external: ["better-sqlite3"],
});
