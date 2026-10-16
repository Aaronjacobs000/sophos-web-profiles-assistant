// Small render helpers shared by the page scripts.

import { icon } from "./icons.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

export function escAttr(s) {
  return esc(s).replace(/'/g, "&#39;");
}

export function tag(text, variant = "", extra = "") {
  const cls = variant ? `tag tag-${variant}` : "tag";
  return `<span class="${cls}"${extra ? ` ${extra}` : ""}>${text}</span>`;
}

export function relTime(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The Build page's headline for the latest plan or build, in plain words rather than its status value. */
export function buildHeadline(rec, readOnly) {
  if (!rec) return "Plan the pilot";
  switch (rec.status) {
    case "dry-run":
      if (!rec.checks.every((c) => c.ok)) return "Dry run found problems";
      return readOnly ? "Dry run passed. Read-only mode, so nothing will be created." : `Dry run passed. Ready to create ${rec.steps.length} objects.`;
    case "built":
      return `Built ${rec.steps.length} objects`;
    case "partial":
      return "Build didn't finish";
    case "failed":
      return "Build failed";
    case "rolled-back":
      return "Rolled back";
    case "rollback-partial":
      return "Rollback didn't finish";
    default:
      return "Build";
  }
}

/** Text as a sentence: a message from Sophos, such as "Sophos API error 500: InternalServerError", often has no closing full stop. */
export function sentence(text) {
  const t = String(text ?? "").trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * What Sophos or the tool answered, on its own Detail line under a plain
 * message, so the message itself stays plain. Empty when there's no answer.
 */
export function detailHtml(raw) {
  const t = sentence(raw);
  return t ? `<span class="err-detail" data-error-detail>Detail: ${esc(t)}</span>` : "";
}

/** A banner that says plainly what went wrong, with what Sophos or the tool answered on a Detail line in it. */
export function errorBanner(plain, raw, variant = "err", style = "") {
  return `<div class="banner banner-${variant}"${style ? ` style="${style}"` : ""}>${esc(plain)}${detailHtml(raw)}</div>`;
}

/** A read-back as recorded ("site listed", or "not read: " and why), split into its plain words and the answer for a Detail line. */
export function readBackParts(text) {
  const t = String(text ?? "");
  const m = /^not read: ([\s\S]+)$/.exec(t);
  return m ? { plain: "not read", detail: m[1] } : { plain: t, detail: "" };
}

/** The note on a pilot whose rollback didn't finish: what it left in the tenant, why, and what to do next. */
export function rollbackUnfinishedBanner(pilot, tenantId) {
  const r = pilot?.rollbackUnfinished;
  if (!r) return "";
  const named = ["policy", "profile"].flatMap((k) => r.left.filter((s) => s.kind === k).map((s) => `the ${k} "${s.name}"`));
  const lists = r.left.filter((s) => s.kind === "site-list").length;
  const parts = [...named, ...(lists ? [plural(lists, "site list")] : [])];
  const left = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "the pilot";
  // Why it didn't finish, often what Sophos answered, goes on the Detail line. It can hold a long URL with an id, so it wraps anywhere.
  return `<div class="banner banner-warn" style="overflow-wrap:anywhere;margin-bottom:10px"><strong>The rollback didn't finish.</strong> Still in the tenant: ${esc(left)}.
    Roll it back again from the <a href="/build.html?tenant=${encodeURIComponent(tenantId)}">Build</a> page, or carry on with the pilot.${detailHtml(r.reason)}</div>`;
}

/** A retire record's status in plain words, for the Retired table and the messages after a retire or restore. */
export function retireStatus(status) {
  return { retired: "Retired", partial: "Retire didn't finish", failed: "Retire failed", restored: "Restored", "restore-partial": "Restore didn't finish" }[status] ?? "Retire";
}

/** A retire step's status in plain words. A planned step in a record was never sent, because the retire stops at the first failure. */
export function retireStepStatus(status) {
  return { planned: "not sent", done: "done", failed: "failed", restored: "restored", "restore-failed": "restore failed" }[status] ?? "unknown";
}

/**
 * A "more" button that opens a small menu. items: [{ label, icon, danger, attrs }]
 * where attrs is a string of data attributes the page wires up itself.
 */
export function rowMenu(items, label = "More actions") {
  const buttons = items.map((it) =>
    `<button type="button" class="${it.danger ? "is-danger" : ""}" ${it.attrs ?? ""}>${it.icon ? icon(it.icon) : ""}${esc(it.label)}</button>`,
  ).join("");
  return `<span class="row-menu"><button type="button" class="icon-btn" data-menu-toggle aria-haspopup="menu" aria-expanded="false" title="${escAttr(label)}" aria-label="${escAttr(label)}">${icon("more")}</button><span class="row-menu-list hidden" role="menu">${buttons}</span></span>`;
}

/**
 * The cell after a source row's checkbox: a tick when the row is already on
 * the destination. The row may be dimmed, but this cell is not.
 */
export function onDestCell(onDest) {
  const label = "Already on the destination";
  return `<td class="col-tick">${onDest ? `<span class="on-dest" role="img" title="${label}" aria-label="${label}">${icon("check")}</span>` : ""}</td>`;
}

/** Header for the tick column. */
export const ON_DEST_HEADER = `<th class="col-tick" title="Already on the destination"></th>`;

let menuWired = false;

/** Opens and closes row menus under root. Safe to call after every render. */
export function wireRowMenus(root = document) {
  root.querySelectorAll("[data-menu-toggle]").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const list = btn.nextElementSibling;
      const open = list.classList.contains("hidden");
      closeAllMenus();
      if (open) {
        list.classList.remove("hidden");
        btn.setAttribute("aria-expanded", "true");
      }
    });
    btn.nextElementSibling.addEventListener("click", () => closeAllMenus());
  });
  if (!menuWired) {
    menuWired = true;
    document.addEventListener("click", closeAllMenus);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllMenus(); });
  }
}

function closeAllMenus() {
  document.querySelectorAll(".row-menu-list:not(.hidden)").forEach((l) => {
    l.classList.add("hidden");
    l.previousElementSibling?.setAttribute("aria-expanded", "false");
  });
}

/** Thin stacked bar for match / differ / source only / dest only counts. */
export function stackBar(c) {
  const total = (c.match ?? 0) + (c.differ ?? 0) + (c.sourceOnly ?? 0) + (c.destOnly ?? 0);
  if (!total) return "";
  const seg = (n, cls) => (n ? `<span class="${cls}" style="flex:${n}"></span>` : "");
  return `<div class="stack-bar" role="img" aria-label="${escAttr(`${c.match ?? 0} match, ${c.differ ?? 0} differ, ${c.sourceOnly ?? 0} source only, ${c.destOnly ?? 0} destination only`)}">${seg(c.match, "s-match")}${seg(c.differ, "s-differ")}${seg(c.sourceOnly, "s-src")}${seg(c.destOnly, "s-dst")}</div>`;
}

/** Outcome name for a copy result from any of the migrate routes. */
export function outcomeOf(r) {
  if (!r.ok) return "failed";
  if (r.action === "skip-exists") return "skipped";
  if (String(r.action).startsWith("dry-run")) return "would-create";
  return "created";
}

/** A result's notes for the results list: settings changed to fit, then anything else the copy noted. */
export function notesOf(r) {
  return [...(r.adjustments ?? []), ...(r.notes ?? [])];
}

/** How many results have each outcome, counted the way the results list tags them. */
export function countOutcomes(results) {
  const n = { created: 0, "would-create": 0, skipped: 0, failed: 0 };
  for (const r of results) n[outcomeOf(r)]++;
  return n;
}
