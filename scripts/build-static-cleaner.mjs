// Builds build/site-list-cleaner.html: one self-contained page (no server, no
// external files) for the paste-and-classify half of the site list cleaner.
// It inlines the compiled domain modules, so run `npm run build` first
// (`npm run build:cleaner` does both). The page calls SophosLabs Intelix
// only. Don't host or publish it; how it ships is the PMs' call.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "backend/dist/domain");
// Dependency order: each module only uses names defined above it.
const modules = ["categories-data", "sites", "csv", "categories", "intelix", "cleanup"];

function strip(code, name) {
  const out = code
    .replace(/^\/\/# sourceMappingURL=.*$/m, "")
    .replace(/^import[^;]*;\s*$/gm, "")
    .replace(/^export \{[^}]*\};?\s*$/gm, "")
    .replace(/^export (?=(const|function|class|async function|let) )/gm, "");
  if (/^\s*(import|export)\b/m.test(out)) throw new Error(`${name}.js still has an import or export the inliner can't handle.`);
  return `// ---- ${name} ----\n${out.trim()}\n`;
}

const lib = modules.map((m) => strip(readFileSync(path.join(dist, `${m}.js`), "utf8"), m)).join("\n");
const app = readFileSync(path.join(root, "scripts/static-cleaner-app.js"), "utf8");
const html = readFileSync(path.join(root, "scripts/static-cleaner-template.html"), "utf8").replace("{{LIB}}", () => lib).replace("{{APP}}", () => app);
mkdirSync(path.join(root, "build"), { recursive: true });
const out = path.join(root, "build/site-list-cleaner.html");
writeFileSync(out, html);
console.log(`wrote ${path.relative(root, out)} (${Math.round(html.length / 1024)} KB)`);
