// Logs: what the server did (newest first) and the audit log of saved snapshots.

import { api } from "./api.js";
import { initShell } from "./shell.js";
import { errorBanner, esc } from "./ui.js";

const main = document.getElementById("main");

function when(iso) {
  const d = new Date(iso);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function render() {
  await initShell();
  const [logs, audit] = await Promise.all([api.get("/api/logs"), api.get("/api/audit")]);
  const rows = [...logs.items].reverse().slice(0, 300);
  main.innerHTML = `
    <section class="page-head"><div><span class="eyebrow">Tools</span><h1>Logs</h1>
      <p class="page-lead">What the server did since it started, newest first. Secrets are masked. The audit log lists every snapshot the tool saves and every change it makes to a tenant.</p></div></section>
    <section class="panel-card"><div class="card-head"><h2>Audit log</h2><span class="tag tag-muted">data/audit.log</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Tenant</th><th>Action</th><th>What</th><th>Result</th></tr></thead><tbody>
      ${audit.items.length ? audit.items.slice(0, 50).map((a) => `<tr><td class="cell-nowrap">${a.ts ? when(a.ts) : ""}</td><td>${esc(a.tenantName ?? a.tenantId ?? "")}</td><td>${esc(a.action ?? "")}</td><td><code>${esc(a.resourceId ?? "")}</code></td><td>${a.ok ? '<span class="tag tag-ok">Done</span>' : '<span class="tag tag-bad">Failed</span>'}</td></tr>`).join("") : '<tr><td colspan="5" class="empty-state">Nothing yet.</td></tr>'}
      </tbody></table></div></section>
    <section class="panel-card"><div class="card-head"><h2>Server log</h2><span class="tag tag-muted">${rows.length} lines</span></div>
      <div class="table-wrap"><table class="data-table logs-table"><thead><tr><th>Time</th><th>Level</th><th>Message</th></tr></thead><tbody>
      ${rows.map((l) => `<tr><td class="cell-nowrap">${when(l.ts)}</td><td><span class="tag ${l.level === "error" ? "tag-bad" : l.level === "warn" ? "tag-warn" : "tag-muted"}">${esc(l.level)}</span></td><td>${l.section ? `<span class="tag tag-muted">${esc(l.section)}</span> ` : ""}${esc(l.message)}</td></tr>`).join("")}
      </tbody></table></div></section>`;
}

render().catch((err) => {
  main.innerHTML = errorBanner("Couldn't read the logs.", err.message);
});
