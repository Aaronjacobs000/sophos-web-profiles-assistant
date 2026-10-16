// Partner mode: a scorecard row for every tenant, a background scan, and a
// link into each tenant's readiness page.

import { api } from "./api.js";
import { getStatus, initShell } from "./shell.js";
import { esc, escAttr } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";

const main = document.getElementById("main");
let filter = "all";
let query = "";
let sort = { key: "name", dir: 1 };
let timer = null;
let last = null;

const n = (x) => Number(x ?? 0).toLocaleString("en-US");

function when(iso, short = false) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (v) => String(v).padStart(2, "0");
  const day = short ? `${p(d.getDate())}/${p(d.getMonth() + 1)}` : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function bucket(r) {
  if (r.status === "reading") return "reading";
  if (r.status === "queued") return "queued";
  if (r.status === "error" || r.verdict === "unreadable") return "unreadable";
  return r.verdict === "ready" ? "ready" : "fixes";
}

const VERDICT = {
  ready: ["Ready", "verdict-ready"],
  fixes: ["Needs fixes", "verdict-fixes"],
  unreadable: ["Unreadable", "verdict-unreadable"],
  reading: ["Reading", "verdict-reading"],
  queued: ["Not scanned", "tag-muted"],
};

const COLUMNS = [
  { key: "name", label: "Tenant" },
  { key: "verdict", label: "Readiness" },
  { key: "fix", label: "Fixes", num: true },
  { key: "plan", label: "Plan", num: true },
  { key: "percent", label: "Eligible devices", num: true },
  { key: "wmEntries", label: "Website Mgmt", num: true },
  { key: "webPolicies", label: "Web policies", num: true },
  { key: "profiles", label: "Profiles", num: true },
  { key: "decryption", label: "Decryption" },
  { key: "readAt", label: "Last read" },
];

function sortValue(r, key) {
  if (key === "verdict") return ["fixes", "ready", "reading", "unreadable", "queued"].indexOf(bucket(r));
  const v = r[key];
  return v === undefined || v === null ? -1 : v;
}

function rowHtml(r) {
  const b = bucket(r);
  const [label, cls] = VERDICT[b];
  const href = `/readiness.html?tenant=${encodeURIComponent(r.tenantId)}`;
  const done = r.status === "done";
  const dec = r.decryption === "on" ? `<span class="on">On</span>` : r.decryption === "off" ? `<span class="off">Off</span>` : r.decryption === "partial" ? `<span style="color:var(--warn)">Partial</span>` : "";
  const why = r.error ?? (r.verdict === "unreadable" ? "Every read was refused." : "");
  return `<tr>
    <td class="t-name"><a href="${escAttr(href)}">${esc(r.name)}</a><span class="t-sub">${esc(r.region ?? "")} · ${esc(r.tenantId.slice(0, 8))}${r.unread ? ` · ${r.unread} unread` : ""}</span></td>
    <td><span class="tag ${cls}"${why ? ` title="${escAttr(why)}"` : ""}>${b === "reading" ? '<span class="spinner" style="width:10px;height:10px"></span>' : ""}${label}</span></td>
    <td class="num">${done && r.verdict !== "unreadable" ? n(r.fix) : ""}</td>
    <td class="num">${done && r.verdict !== "unreadable" ? n(r.plan) : ""}</td>
    <td class="num">${done && r.inScope !== undefined && r.inScope !== null ? (r.inScope === 0 ? '<span class="muted">no devices</span>' : `${n(r.eligible)} of ${n(r.inScope)}<span class="pct">${r.percent ?? 0}%</span>`) : ""}</td>
    <td class="num">${done && r.wmEntries !== null && r.wmEntries !== undefined ? n(r.wmEntries) : ""}</td>
    <td class="num">${done && r.verdict !== "unreadable" ? n(r.webPolicies) : ""}</td>
    <td class="num">${done && r.profiles !== null && r.profiles !== undefined ? n(r.profiles) : ""}</td>
    <td>${done ? dec : ""}</td>
    <td class="cell-nowrap">${r.readAt ? `${when(r.readAt, true)}<span class="t-sub">${n(r.calls)} reads, ${duration(r.durationMs)}</span>` : ""}</td>
  </tr>`;
}

function render(run) {
  last = run;
  const counts = { ready: 0, fixes: 0, unreadable: 0, queued: 0, reading: 0 };
  for (const r of run.rows) counts[bucket(r)]++;
  const scanned = run.rows.filter((r) => r.status === "done");
  const eligible = scanned.reduce((s, r) => s + (r.eligible ?? 0), 0);
  const inScope = scanned.reduce((s, r) => s + (r.inScope ?? 0), 0);
  const wm = scanned.reduce((s, r) => s + (r.wmEntries ?? 0), 0);

  let rows = run.rows.filter((r) => filter === "all" || bucket(r) === filter || (filter === "queued" && bucket(r) === "reading"));
  if (query) rows = rows.filter((r) => `${r.name} ${r.tenantId}`.toLowerCase().includes(query));
  rows = [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    const c = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) : va < vb ? -1 : va > vb ? 1 : 0;
    return c * sort.dir || a.name.localeCompare(b.name);
  });

  const progress = run.running
    ? `<section class="panel-card estate-progress"><div><p style="margin:0 0 8px"><span class="running-line" style="justify-content:flex-start"><span class="spinner"></span>Scanning ${n(run.done)} of ${n(run.total)} tenants, ${run.concurrency} at a time. ${n(run.calls)} reads so far.</span></p><div class="bar"><div class="bar-fill is-live" style="width:${run.total ? (run.done / run.total) * 100 : 0}%"></div></div></div><span class="hint">Started ${when(run.startedAt)}</span></section>`
    : run.finishedAt
      ? `<p class="hint" style="margin:-8px 0 16px">Last scan ${when(run.startedAt)}: ${n(run.total)} tenants in ${duration(run.durationMs)}, ${n(run.calls)} read-only calls, ${run.concurrency} at a time.</p>`
      : "";

  const tabs = [
    ["all", "All", run.rows.length],
    ["fixes", "Needs fixes", counts.fixes],
    ["ready", "Ready", counts.ready],
    ["unreadable", "Unreadable", counts.unreadable],
    ["queued", "Not scanned", counts.queued + counts.reading],
  ]
    .map(([k, label, c]) => `<button type="button" class="seg-btn${filter === k ? " is-active" : ""}" data-filter="${k}">${label} <span class="seg-count">${n(c)}</span></button>`)
    .join("");

  const status = getStatus();
  const who = status?.partner?.label || (status?.partner ? `${status.partner.idType === "organization" ? "Organization" : "Partner"} ${status.partner.id.slice(0, 8)}` : "Estate");

  main.innerHTML = `
    <section class="page-head">
      <div>
        <span class="eyebrow">Partner estate</span>
        <h1>${esc(who)}: ${n(run.rows.length)} tenants</h1>
        <p class="page-lead">Every tenant gets the same readiness scorecard and rollback snapshot as a single-tenant check. Reads only. Open a tenant for its full scorecard and customer report.</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-lg btn-primary" id="scan"${run.running ? " disabled" : ""}>${icon("play")}${run.finishedAt || scanned.length ? "Scan all again" : "Scan all tenants"}</button>
      </div>
    </section>
    ${progress}
    <div class="estate-chips">
      <span class="count-chip is-fix"><b>${n(counts.fixes)}</b><span>need fixes before a pilot</span></span>
      <span class="count-chip is-ready"><b>${n(counts.ready)}</b><span>ready for a pilot</span></span>
      <span class="count-chip is-unread"><b>${n(counts.unreadable)}</b><span>unreadable</span></span>
      <span class="count-chip"><b>${n(eligible)}</b><span>of ${n(inScope)} devices can use profiles</span></span>
      <span class="count-chip"><b>${n(wm)}</b><span>Website Management entries</span></span>
    </div>
    <section class="panel-card">
      <div class="card-head"><div class="seg">${tabs}</div><span class="spacer"></span><input type="search" id="q" placeholder="Find a tenant" value="${escAttr(query)}" /></div>
      <div class="table-wrap"><table class="data-table estate-table">
        <thead><tr>${COLUMNS.map((c) => `<th class="sortable-th${c.num ? " num" : ""}${sort.key === c.key ? (sort.dir > 0 ? " sort-asc" : " sort-desc") : ""}" data-sort="${c.key}">${c.label}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(rowHtml).join("") || `<tr><td colspan="${COLUMNS.length}" class="empty-state">No tenants match.</td></tr>`}</tbody>
      </table></div>
    </section>`;

  main.querySelector("#scan").addEventListener("click", scan);
  main.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; render(last); }));
  main.querySelectorAll("[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === "name" ? 1 : -1 };
      render(last);
    }),
  );
  const q = main.querySelector("#q");
  q.addEventListener("input", () => {
    query = q.value.trim().toLowerCase();
    const pos = q.selectionStart;
    render(last);
    const again = main.querySelector("#q");
    again.focus();
    again.setSelectionRange(pos, pos);
  });

  clearTimeout(timer);
  if (run.running) timer = setTimeout(load, 2500);
}

async function scan() {
  try {
    render(await api.post("/api/estate/scan", {}));
    toast("Scan started.", "ok");
  } catch (err) {
    toast("Couldn't start the scan.", "warn", 8000, err.message);
  }
}

async function load() {
  try {
    render(await api.get("/api/estate"));
  } catch (err) {
    main.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
  }
}

async function start() {
  const status = await initShell();
  if (status?.mode !== "partner") {
    main.innerHTML = `<div class="banner banner-info">The estate view needs a partner or organization credential. <a href="/credentials.html">Change the credential</a>, or open the <a href="/">tenant's readiness</a>.</div>`;
    return;
  }
  load();
}

start();
