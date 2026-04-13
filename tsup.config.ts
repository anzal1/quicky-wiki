import { defineConfig } from "tsup";

export default defineConfig([
  {
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
  },
  {
    entry: ["src/lib.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    sourcemap: true,
    dts: true,
    banner: {
      js: 'import{createRequire}from"module";const require=createRequire(import.meta.url);',
    },
    external: ["better-sqlite3"],
  },
]);
