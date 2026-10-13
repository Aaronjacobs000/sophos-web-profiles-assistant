// The clean-up results view, shared by the clean-up step and the standalone
// site list cleaner: summary bar, planned lists with exports, the results
// table with filters, and per-entry decisions.

import { api } from "./api.js";
import { esc, escAttr } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";

export const n = (x) => Number(x ?? 0).toLocaleString("en-US");

const VERDICT_TAG = {
  covered: '<span class="tag tag-ok">Covered</span>',
  exception: '<span class="tag tag-accent">Exception</span>',
  remove: '<span class="tag tag-muted">Remove</span>',
};
const ACTION_TAG = { allow: "tag-ok", block: "tag-bad", warn: "tag-warn", mixed: "tag-warn", none: "tag-muted" };

export function summaryHtml(summary) {
  if (!summary?.total) return "";
  const pct = (x) => (summary.total ? (x / summary.total) * 100 : 0);
  return `<div class="cu-bar" role="img" aria-label="${escAttr(`${summary.covered} covered, ${summary.remove} remove, ${summary.exception} exceptions`)}">
      <span class="c-cov" style="width:${pct(summary.covered)}%"></span><span class="c-rem" style="width:${pct(summary.remove)}%"></span><span class="c-exc" style="width:${pct(summary.exception)}%"></span>
    </div>
    <div class="cu-counts">
      <span><b>${n(summary.covered)}</b> covered by a category</span>
      <span><b>${n(summary.remove)}</b> remove: dead, repeated, or unused</span>
      <span><b>${n(summary.exception)}</b> exceptions for site lists</span>
      ${summary.needsDecision ? `<span class="cu-decide">Of these, <b>${n(summary.needsDecision)}</b> need a decision</span>` : ""}
    </div>`;
}

export function listsHtml(view, base) {
  const lists = view.lists ?? [];
  const cards = lists
    .map(
      (l, i) => `<div class="cu-list"><span class="tag ${ACTION_TAG[l.action]}">${esc(l.action)}</span><div><b>${esc(l.name)}</b><span class="hint">${n(l.sites)} ${l.sites === 1 ? "site" : "sites"}</span></div><a class="btn btn-small" href="${base}/${i}.csv">${icon("download")}CSV</a></div>`,
    )
    .join("");
  return `<div class="cu-lists">${cards || '<p class="muted">No exceptions to put in a site list yet.</p>'}
    <div class="cu-list-actions">
      <a class="btn" href="${base}/results.csv">${icon("download")}All results (CSV)</a>
      ${view.canCreate ? `<button class="btn btn-soft" id="create-lists"${lists.length ? "" : " disabled"}>${icon("play")}Create site lists</button>` : ""}
      ${view.lastLists?.lists?.some((l) => l.status === "created") ? '<button class="btn" id="undo-lists">Undo last lists</button>' : ""}
    </div>
    ${view.leftOut ? `<p class="hint">${n(view.leftOut)} ${view.leftOut === 1 ? "entry is" : "entries are"} left out until you decide: broad entries, and entries with different actions in different policies.</p>` : ""}
  </div>`;
}

let filter = "all";
let query = "";

function rowHtml(r) {
  const verdict = r.decided?.verdict ?? r.verdict;
  const action = r.decided?.action ?? r.action;
  const cat = r.categoryLabel ?? r.lookup?.productivityCategory ?? (r.lookupError ? "Lookup failed" : "Not looked up");
  const risk = r.lookup?.riskLevel ?? "";
  return `<tr data-id="${escAttr(r.id)}">
    <td class="cu-site"><b>${esc(r.site.value || r.raw)}</b>${r.site.value && r.site.value !== r.raw.trim() ? `<span class="t-sub">was ${esc(r.raw)}</span>` : ""}</td>
    <td>${r.tags.length ? esc(r.tags.join(", ")) : '<span class="muted">none</span>'}<span class="t-sub"><span class="tag ${ACTION_TAG[action] ?? "tag-muted"}">${esc(action)}</span></span></td>
    <td>${esc(cat)}${r.lookup?.securityRisk ? `<span class="t-sub" style="color:var(--bad)">${esc(r.lookup.securityCategory)}</span>` : ""}</td>
    <td>${risk ? `<span class="${risk === "HIGH" ? "off" : ""}">${esc(risk)}</span>` : '<span class="muted">none</span>'}</td>
    <td>${r.dns ? esc(r.dns.status) : '<span class="muted">not checked</span>'}</td>
    <td>${VERDICT_TAG[verdict]}${r.needsDecision && !r.decided ? ' <span class="tag tag-warn">Decide</span>' : ""}</td>
    <td class="cu-why">${esc(r.decided ? "Your decision." : r.reason)}</td>
    <td><select class="cu-decision" aria-label="Decision">
      <option value="">${r.decided ? "Undo decision" : "Keep"}</option>
      <option value="covered"${r.decided?.verdict === "covered" ? " selected" : ""}>Covered</option>
      <option value="exception"${r.decided?.verdict === "exception" ? " selected" : ""}>Exception</option>
      <option value="remove"${r.decided?.verdict === "remove" ? " selected" : ""}>Remove</option>
    </select></td>
  </tr>`;
}

export function tableHtml(results) {
  const counts = { all: results.length, exception: 0, covered: 0, remove: 0, decide: 0 };
  for (const r of results) {
    counts[r.decided?.verdict ?? r.verdict]++;
    if (r.needsDecision && !r.decided) counts.decide++;
  }
  const shown = results.filter((r) => {
    const v = r.decided?.verdict ?? r.verdict;
    if (filter === "decide" && !(r.needsDecision && !r.decided)) return false;
    if (filter !== "all" && filter !== "decide" && v !== filter) return false;
    if (query && !`${r.raw} ${r.site.value} ${r.tags.join(" ")}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const tabs = [["all", "All"], ["exception", "Exceptions"], ["covered", "Covered"], ["remove", "Remove"], ["decide", "Need a decision"]]
    .map(([k, label]) => `<button type="button" class="seg-btn${filter === k ? " is-active" : ""}" data-filter="${k}">${label} <span class="seg-count">${n(counts[k])}</span></button>`)
    .join("");
  return `<section class="panel-card">
    <div class="card-head"><div class="seg">${tabs}</div><span class="spacer"></span><input type="search" id="cu-q" placeholder="Search sites or tags" value="${escAttr(query)}" /></div>
    <div class="table-wrap"><table class="data-table cu-table"><thead><tr><th>Site</th><th>Tag today</th><th>SophosLabs category</th><th>Risk</th><th>DNS</th><th>Verdict</th><th>Why</th><th>Decide</th></tr></thead>
    <tbody>${shown.slice(0, 500).map(rowHtml).join("") || '<tr><td colspan="8" class="empty-state">Nothing here.</td></tr>'}</tbody></table></div>
    ${shown.length > 500 ? `<p class="hint">Showing 500 of ${n(shown.length)}. The CSV has them all.</p>` : ""}
  </section>`;
}

/** Wires filters, search, decisions and list buttons. `endpoints` names the page's API paths. */
export function wireView(root, view, endpoints, rerender) {
  root.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; rerender(view); }));
  const q = root.querySelector("#cu-q");
  q?.addEventListener("input", () => {
    query = q.value.trim().toLowerCase();
    const pos = q.selectionStart;
    rerender(view);
    const again = root.querySelector("#cu-q");
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  root.querySelectorAll(".cu-decision").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const id = sel.closest("tr").dataset.id;
      const r = view.results.find((x) => x.id === id);
      const verdict = sel.value;
      const decision = verdict ? { verdict, ...(r.action === "mixed" && verdict === "exception" ? { action: "block" } : {}) } : null;
      try {
        const next = await api.put(endpoints.decisions, { decisions: { [id]: decision } });
        rerender({ ...view, ...next });
      } catch (err) {
        toast(err.message, "warn", 8000);
      }
    }),
  );
  root.querySelector("#create-lists")?.addEventListener("click", async () => {
    try {
      const plan = await api.post(endpoints.lists, { ...endpoints.listBody, dryRun: true });
      if (plan.problems?.length) {
        toast(plan.problems.join(" "), "warn", 10000);
        return;
      }
      const ok = window.confirm(`Dry run passed. Create ${plan.lists.length} site ${plan.lists.length === 1 ? "list" : "lists"} (${plan.lists.map((l) => `${l.name}: ${l.sites.length}`).join(", ")})? Each is read back and recorded in the audit log, and Undo deletes them.`);
      if (!ok) return;
      const rec = await api.post(endpoints.lists, { ...endpoints.listBody, dryRun: false });
      const made = rec.lists.filter((l) => l.status === "created").length;
      toast(`${made} site ${made === 1 ? "list" : "lists"} created and read back.`, made === rec.lists.length ? "ok" : "warn", 8000);
      rerender({ ...view, lastLists: rec });
    } catch (err) {
      toast(err.message, "warn", 10000);
    }
  });
  root.querySelector("#undo-lists")?.addEventListener("click", async () => {
    if (!window.confirm("Delete the site lists the last create made? Lists a profile uses are left.")) return;
    try {
      const rec = await api.post(endpoints.lists, { ...endpoints.listBody, undo: true });
      toast(`Undo: ${rec.lists.map((l) => `${l.name} ${l.status}`).join(", ")}.`, "ok", 8000);
      rerender({ ...view, lastLists: rec });
    } catch (err) {
      toast(err.message, "warn", 10000);
    }
  });
}
