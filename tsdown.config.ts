import { defineConfig } from "tsdown";

/** DSH client modules consume a lazy CJS factory, not a plain ESM entry. */
export default defineConfig({
  entry: { client: "src/dsh-client.ts" },
  outDir: "lib",
  format: ["cjs"],
  platform: "browser",
  target: "es2022",
  dts: false,
  sourcemap: true,
  clean: false,
  external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  outputOptions: {
    entryFileNames: "client.js",
    banner: 'window.__ModuleLoader__.load({ id: "dsh-collab", factory: (require) => {',
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
});
