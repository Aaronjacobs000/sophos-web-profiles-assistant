// Readiness: the scorecard for one tenant, the facts behind it, the
// rollback snapshot and the customer report.

import { api } from "./api.js";
import { currentTenantId, getStatus, initShell, setTenant } from "./shell.js";
import { esc, escAttr } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";

const main = document.getElementById("main");
const GROUPS = [
  { sev: "fix", title: "Fix before the pilot" },
  { sev: "plan", title: "Plan around" },
  { sev: "info", title: "Check by hand" },
];

function when(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function n(x) {
  return Number(x ?? 0).toLocaleString("en-US");
}

function plural(count, one, many = `${one}s`) {
  return `${n(count)} ${count === 1 ? one : many}`;
}

function itemHtml(item) {
  const ev = item.evidence?.length
    ? `<details class="score-ev"><summary>${item.evidence.length + (item.evidenceMore ?? 0) === 1 ? "Show the one item" : `Show ${n(item.evidence.length + (item.evidenceMore ?? 0))} items`}</summary><ul>${item.evidence
        .map((e) => `<li>${esc(e)}</li>`)
        .join("")}${item.evidenceMore ? `<li class="muted">and ${n(item.evidenceMore)} more (all in the snapshot)</li>` : ""}</ul></details>`
    : "";
  return `<div class="score-item" data-id="${escAttr(item.id)}">
    <div>
      <div class="score-title">${esc(item.title)}</div>
      ${item.detail ? `<p class="score-detail">${esc(item.detail)}</p>` : ""}
      ${item.fix ? `<p class="score-fix"><b>What to do:</b> ${esc(item.fix)}</p>` : ""}
    </div>
    ${item.topic ? `<span class="tag tag-muted score-doc" title="Topic">${esc(item.topic)}</span>` : ""}
    ${ev}
  </div>`;
}

function groupsHtml(sc) {
  const out = [];
  for (const g of GROUPS) {
    const list = sc.items.filter((i) => i.severity === g.sev);
    if (!list.length) continue;
    out.push(`<section class="panel-card sev-${g.sev}">
      <div class="group-head"><h2>${g.title}</h2><span class="group-count">${list.length}</span></div>
      ${list.map(itemHtml).join("")}
    </section>`);
  }
  const ok = sc.items.filter((i) => i.severity === "ok");
  if (ok.length) {
    out.push(`<section class="panel-card sev-ok">
      <div class="group-head"><h2>Passing</h2><span class="group-count">${ok.length}</span></div>
      <div class="ok-strip">${ok.map((i) => `<span>${esc(i.title)}</span>`).join("")}</div>
    </section>`);
  }
  return out.join("");
}

function eligibilityHtml(e) {
  if (!e) return `<section class="panel-card"><span class="eyebrow">Eligible for profiles</span><p class="muted">Devices couldn't be read.</p></section>`;
  const mac = e.byReason.macos;
  const old = e.byReason["windows-old-agent"] + e.byReason["windows-no-agent-version"];
  const other = e.byReason.other;
  const pct = (x) => (e.inScope ? (x / e.inScope) * 100 : 0);
  const versions = e.oldWindowsVersions.slice(0, 4).map((v) => `${v.version} (${v.count})`).join(", ");
  return `<section class="panel-card">
    <span class="eyebrow">Eligible for profiles</span>
    <div class="kpi-big" style="margin-top:10px">${n(e.eligible)}<small>of ${plural(e.inScope, "device")}, ${e.percent}%</small></div>
    <div class="elig-bar" role="img" aria-label="${escAttr(`${e.eligible} eligible, ${mac} macOS, ${old} older Windows`)}">
      ${e.eligible ? `<span class="e-ok" style="width:${pct(e.eligible)}%"></span>` : ""}
      ${mac ? `<span class="e-mac" style="width:${pct(mac)}%"></span>` : ""}
      ${old ? `<span class="e-old" style="width:${pct(old)}%"></span>` : ""}
      ${other ? `<span class="e-other" style="width:${pct(other)}%"></span>` : ""}
    </div>
    <div class="legend">
      <span><i style="background:var(--accent)"></i>Windows 2026.1 or later ${n(e.eligible)}</span>
      <span><i style="background:#9bcfde"></i>macOS ${n(mac)}</span>
      <span><i style="background:var(--warn)"></i>Older Windows ${n(old)}</span>
      ${other ? `<span><i style="background:var(--ink-4)"></i>Other ${n(other)}</span>` : ""}
    </div>
    <p class="hint" style="margin:10px 0 0">Computers ${n(e.computers.eligible)} of ${n(e.computers.inScope)}, servers ${n(e.servers.eligible)} of ${n(e.servers.inScope)}.${
      e.byReason.linux ? ` ${plural(e.byReason.linux, "Linux device")} left out: Web Control doesn't apply to Linux.` : ""
    }${versions ? ` Older Windows agents: ${esc(versions)}.` : ""}</p>
  </section>`;
}

function kpisHtml(f) {
  const wm = f.websiteManagement;
  const prof = f.profiles;
  return `<div class="kpi-pair">
    <section class="panel-card"><div class="kpi-num">${wm ? n(wm.entries) : "?"}</div><div class="kpi-label">Website Management entries${wm ? ` in ${plural(wm.tags, "tag")}` : ""}</div></section>
    <section class="panel-card"><div class="kpi-num">${prof ? `${prof.count} / ${prof.limit}` : "?"}</div><div class="kpi-label">web filtering profiles in use${f.siteLists ? `, ${plural(f.siteLists.count, "site list")}` : ""}</div></section>
  </div>`;
}

function orderHtml(policies) {
  if (!policies.length) return "";
  const groups = [
    { type: "web-control", label: "Computer Web Control, top wins" },
    { type: "server-web-control", label: "Server Web Control, top wins" },
  ];
  return groups
    .map((g) => {
      const all = policies.filter((p) => p.type === g.type);
      if (!all.length) return "";
      // The Base policy stays visible at the bottom; long lists are cut in the middle.
      const list = all.length > 12 ? [...all.slice(0, 10), ...all.filter((p) => p.base)] : all;
      const more = all.length - list.length;
      return `<section class="panel-card"><span class="eyebrow">${g.label}</span><ul class="order-list" style="margin-top:8px">${list
        .map(
          (p) => `<li><span class="o-name">${esc(p.name)}<span class="o-kind">${p.base ? "Base" : `Priority ${p.priority}`}${p.enabled ? "" : ", disabled"}, ${p.mode === "profile" ? "web profile" : "classic"}${p.tags ? `, ${plural(p.tags, "tag")}` : ""}</span></span><span class="o-meta">${esc(p.assignedTo)}</span></li>`,
        )
        .join("")}</ul>${more > 0 ? `<p class="hint" style="margin:8px 0 0">${n(more)} more in the customer report and the snapshot.</p>` : ""}</section>`;
    })
    .join("");
}

function decryptionHtml(rows) {
  if (!rows.length) return "";
  const cell = (v) => (v === null ? "" : v ? `<span class="on">On</span>` : `<span class="off">Off</span>`);
  return `<section class="panel-card"><span class="eyebrow">Threat Protection</span>
    <table class="mini-table" style="margin-top:8px"><thead><tr><th>Policy</th><th>Decryption</th><th>Block QUIC</th></tr></thead><tbody>${rows
      .map((d) => `<tr><td>${esc(d.policy)}${d.type === "server-threat-protection" ? ' <span class="muted">(server)</span>' : ""}${d.enabled ? "" : ' <span class="muted">(off)</span>'}</td><td>${cell(d.decryption)}</td><td>${cell(d.quic)}</td></tr>`)
      .join("")}</tbody></table></section>`;
}

function snapshotHtml(tenantId, r) {
  const counts = r.scorecard.facts;
  const wm = counts.websiteManagement?.entries;
  const report = `<a class="btn" href="/api/report/${encodeURIComponent(tenantId)}.html?download=1&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}">${icon("download")}Customer report (HTML)</a>
    <a class="btn" id="pdf" href="/api/report/${encodeURIComponent(tenantId)}.pdf?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}">${icon("download")}Customer report (PDF)</a>`;
  if (!r.snapshot) {
    return `<section class="panel-card snapshot-bar"><p><strong>No rollback snapshot.</strong> ${esc(r.snapshotError ?? "The tenant couldn't be read.")}</p><div class="head-actions">${report}</div></section>`;
  }
  return `<section class="panel-card snapshot-bar">
    <p><strong>Rollback snapshot saved.</strong> ${plural(counts.policies.length, "Web Control policy", "Web Control policies")}, ${wm === undefined ? "" : `${plural(wm, "Website Management entry", "Website Management entries")}, `}${plural(counts.decryption.length, "Threat Protection policy", "Threat Protection policies")}, and every profile and site list, as read.<br /><code>${esc(r.snapshot.file)}</code></p>
    <div class="head-actions">
      <a class="btn" href="/api/snapshots/${encodeURIComponent(tenantId)}/${encodeURIComponent(r.snapshot.file)}">${icon("download")}Download snapshot</a>
      ${report}
    </div>
  </section>`;
}

function render(tenant, r) {
  const sc = r.scorecard;
  const unread = sc.unread.length
    ? `<div class="banner banner-warn" style="margin-bottom:16px">${plural(sc.unread.length, "section")} couldn't be read, so some checks were skipped: ${esc(sc.unread.map((u) => u.label).join(", "))}.</div>`
    : "";
  main.innerHTML = `
    <section class="page-head">
      <div>
        <span class="eyebrow">Readiness, read ${when(r.readAt)}</span>
        <h1>${esc(sc.headline)}</h1>
        <p class="page-lead">${esc(sc.summary)}</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-lg" id="rerun">${icon("refresh")}Check again</button>
        <a class="btn btn-lg btn-primary" href="/cleanup.html?tenant=${encodeURIComponent(tenant.id)}">Continue to clean up</a>
      </div>
    </section>
    ${unread}
    <div class="score-grid">
      <div class="score-main">${groupsHtml(sc)}</div>
      <aside class="score-side">
        ${eligibilityHtml(sc.facts.eligibility)}
        ${kpisHtml(sc.facts)}
        ${orderHtml(sc.facts.policies)}
        ${decryptionHtml(sc.facts.decryption)}
      </aside>
    </div>
    ${snapshotHtml(tenant.id, r)}
    <div class="meta-foot"><span>Read only: ${plural(r.calls, "Fusion API read")} in ${(r.durationMs / 1000).toFixed(1)} s. Nothing in the tenant changed.</span><span>Tenant <code>${esc(tenant.id)}</code>${tenant.region ? `, ${esc(tenant.region)}` : ""}</span></div>
  `;
  document.getElementById("rerun").addEventListener("click", () => run(tenant));
  wirePdf();
}

function wirePdf() {
  const a = document.getElementById("pdf");
  if (!a) return;
  a.addEventListener("click", async (e) => {
    e.preventDefault();
    const label = a.innerHTML;
    a.innerHTML = `<span class="spinner"></span>Printing PDF`;
    try {
      const res = await fetch(a.href);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "report.pdf";
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast("Couldn't make the PDF.", "warn", 9000, err.message);
    } finally {
      a.innerHTML = label;
    }
  });
}

function renderEmpty(tenant, running) {
  main.innerHTML = `
    <section class="page-head"><div><span class="eyebrow">Readiness</span><h1>${esc(tenant.name)}</h1>
      <p class="page-lead">The check reads devices, Web Control and Threat Protection policies, Website Management, decryption and scanning exclusions, users and groups, and any profiles and site lists. It scores what's ready for web filtering profiles and saves a rollback snapshot. It changes nothing.</p></div></section>
    <section class="panel-card run-card">
      ${
        running
          ? `<p class="running-line"><span class="spinner"></span>Reading ${esc(tenant.name)}. Most tenants take under a minute.</p>`
          : `<h2>Run the readiness check</h2><p>Usually 13 to 40 read-only API calls, depending on the size of the tenant.</p><button class="btn btn-lg btn-primary" id="run">${icon("play")}Run the check</button>`
      }
    </section>`;
  document.getElementById("run")?.addEventListener("click", () => run(tenant));
}

async function run(tenant) {
  renderEmpty(tenant, true);
  try {
    const r = await api.post(`/api/readiness/${encodeURIComponent(tenant.id)}/run`, {});
    render(r.tenant, r.result);
    toast("Check finished. Snapshot saved.", "ok");
  } catch (err) {
    renderEmpty(tenant, false);
    main.insertAdjacentHTML("afterbegin", `<div class="banner banner-err" style="margin-bottom:16px">${esc(err.message)}</div>`);
  }
}

async function start() {
  await initShell();
  const tenantId = currentTenantId();
  if (!tenantId) {
    window.location.href = getStatus()?.mode === "partner" ? "/estate.html" : "/";
    return;
  }
  try {
    const r = await api.get(`/api/readiness/${encodeURIComponent(tenantId)}`);
    setTenant(r.tenant);
    document.title = `${r.tenant.name} · Readiness · Web Profiles Assistant`;
    if (r.result) render(r.tenant, r.result);
    else if (r.running) {
      renderEmpty(r.tenant, true);
      setTimeout(start, 3000);
    } else if (new URLSearchParams(location.search).get("run") === "1") run(r.tenant);
    else renderEmpty(r.tenant, false);
  } catch (err) {
    main.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
  }
}

start();
