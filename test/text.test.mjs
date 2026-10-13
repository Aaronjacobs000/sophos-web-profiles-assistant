// Writing rules for anything a customer or partner reads: no em or en dashes,
// US spelling for the words most likely to slip, Sophos Fusion naming, and the
// unofficial label on every page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend");
const files = [
  ...readdirSync(frontend).filter((f) => f.endsWith(".html")).map((f) => path.join(frontend, f)),
  ...readdirSync(path.join(frontend, "js"))
    .filter((f) => f.startsWith("page-") || f === "shell.js")
    .map((f) => path.join(frontend, "js", f)),
  path.join(root, "backend/src/domain/scorecard.ts"),
  path.join(root, "backend/src/domain/report.ts"),
  path.join(root, "README.md"),
];

test("no em or en dashes in UI text, the report or the README", () => {
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /[–—]/, path.relative(root, f));
  }
});

test("US spelling and Sophos Fusion naming", () => {
  const british = /\b(licence|organis\w+|categoris\w+|colour\w*|behaviour\w*|favourite|analys(e|ed|ing)|recognis\w+|centre)\b/i;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, british, path.relative(root, f));
    assert.doesNotMatch(text, /Sophos Taegis/, path.relative(root, f));
    assert.doesNotMatch(text.replace(/central\.sophos\.com|sophos-central|Sophos Central API|\(formerly Sophos Central\)/g, ""), /Sophos Central\b/, path.relative(root, f));
  }
});

test("every page carries the unofficial label", () => {
  const shell = readFileSync(path.join(frontend, "js", "shell.js"), "utf8");
  assert.match(shell, /Unofficial tool, not from Sophos/);
  for (const f of ["welcome.html"]) {
    assert.match(readFileSync(path.join(frontend, f), "utf8"), /Unofficial tool, not from Sophos/);
  }
});

test("no labels that point at outside documentation sections", () => {
  const extra = [path.join(root, "scripts/static-cleaner-template.html"), path.join(root, "scripts/static-cleaner-app.js"), path.join(root, "frontend/js/cleanup-view.js")];
  for (const f of [...files, ...extra]) {
    const text = readFileSync(f, "utf8");
    // Character classes keep a repo-wide grep for these words at zero hits.
    assert.doesNotMatch(text, /\bgu[i]de\b|check[l]ist|pit[f]all|Gap ch[e]ck|\bStep \d/i, path.relative(root, f));
  }
});

test("every scorecard item carries a plain topic label", async () => {
  const { buildScorecard } = await import("../backend/dist/domain/scorecard.js");
  const { inventory } = await import("./fixtures.mjs");
  const allowed = new Set(["Requirements", "Inventory", "Website Management", "Profiles", "Pilot", "Decryption", "Classic settings"]);
  const sc = buildScorecard(inventory());
  assert.ok(sc.items.length > 5);
  for (const i of sc.items) assert.ok(allowed.has(i.topic), `${i.id}: ${i.topic}`);
  const { renderReport } = await import("../backend/dist/domain/report.js");
  assert.equal(typeof renderReport, "function");
});

test("no build-plan drop numbers in UI text or the README", () => {
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /\bdrops? \d/i, path.relative(root, f));
  }
});
