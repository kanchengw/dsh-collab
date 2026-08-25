import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { transform } from "lightningcss";

const CSS_PREFIX = "\0dsh-collab-css:";
const CSS_SUFFIX = ":module";

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
  deps: { neverBundle: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"] },
  plugins: [{
    name: "dsh-collab-css-module",
    resolveId(source, importer) {
      if (!source.endsWith(".module.css") || !importer) return null;
      return CSS_PREFIX + resolve(dirname(importer), source) + CSS_SUFFIX;
    },
    load(id) {
      if (!id.startsWith(CSS_PREFIX) || !id.endsWith(CSS_SUFFIX)) return null;
      const path = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length);
      const compiled = transform({ filename: path, code: readFileSync(path), cssModules: { pattern: "dshCollab_[local]_[hash]" }, minify: true });
      const classes = Object.fromEntries(Object.entries(compiled.exports ?? {}).map(([name, value]) => [name, value.name]));
      return [
        `const cssText = ${JSON.stringify(compiled.code.toString())};`,
        'if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-collab-css]")) {',
        '  const tag = document.createElement("style");',
        '  tag.setAttribute("data-dsh-collab-css", "settings");',
        '  tag.textContent = cssText;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join("\n");
    },
  }],
  outputOptions: {
    entryFileNames: "client.js",
    banner: 'window.__ModuleLoader__.load({ id: "dsh-collab", factory: (require) => {',
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
});
