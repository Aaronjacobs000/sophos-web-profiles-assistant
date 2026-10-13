// The tenant compared with a snapshot, shared by the build and the promote
// and retire pages.

import { esc } from "./ui.js";

export function diffHtml(d) {
  if (!d) return "";
  const rows = d.sections
    .filter((s) => s.changed.length || s.missing.length || s.extra.length || s.matched)
    .map((s) => `<tr><td>${esc(s.section)}</td><td class="num">${s.matched}</td><td class="num">${s.changed.length}</td><td class="num">${s.missing.filter((m) => m.byTool).length}</td><td class="num">${s.extra.filter((e) => e.byTool).length}</td><td class="num">${s.extra.filter((e) => !e.byTool).length + s.missing.filter((m) => !m.byTool).length}</td><td class="cu-why">${esc([...s.changed.map((c) => `${c.name}: ${c.fields.join(", ")}`), ...s.missing.map((m) => `${m.byTool ? "deleted by this tool" : "removed by someone else"}: ${m.name}`), ...s.extra.map((e) => `${e.byTool ? "left by this tool" : "added by someone else"}: ${e.name}`)].slice(0, 6).join("; "))}</td></tr>`)
    .join("");
  return `<section class="panel-card"><div class="card-head"><h2>Tenant compared with ${esc(d.snapshotFile)}</h2><span class="spacer"></span>${d.identical ? '<span class="tag tag-ok">Identical to the snapshot</span>' : d.matches ? '<span class="tag tag-ok">Matches for everything this tool touched</span>' : '<span class="tag tag-bad">Differs</span>'}</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Section</th><th class="num">Same</th><th class="num">Changed</th><th class="num">Missing</th><th class="num">Left by tool</th><th class="num">Others'</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${d.othersCount ? `<p class="hint">${d.othersCount} objects were added or removed by someone else since the snapshot. They aren't this tool's, so they don't count against a match.</p>` : ""}</section>`;
}
