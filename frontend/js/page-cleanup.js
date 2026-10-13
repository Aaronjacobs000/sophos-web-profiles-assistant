// Clean up: every Website Management entry checked against
// SophosLabs (Intelix) and DNS, sorted into Covered, Exception or Remove.

import { api } from "./api.js";
import { currentTenantId, getStatus, initShell, setTenant } from "./shell.js";
import { esc } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { listsHtml, n, summaryHtml, tableHtml, wireView } from "./cleanup-view.js";

const main = document.getElementById("main");
let tenantId = null;
let timer = null;

function render(view) {
  const t = encodeURIComponent(tenantId);
  const run = view.run;
  const s = view.summary;
  const head = s
    ? `${n(s.total)} legacy ${s.total === 1 ? "entry comes" : "entries come"} down to ${n(s.exception)} site list ${s.exception === 1 ? "entry" : "entries"}`
    : "Clean up Website Management";
  const running = run?.running;
  main.innerHTML = `
    <section class="page-head">
      <div>
        <span class="eyebrow">Clean up${run ? `, ${run.options.intelix ? `${n(run.intelixLookups)} SophosLabs lookups` : "no SophosLabs lookups"}${run.options.dns ? ", DNS checked" : ""}` : ""}</span>
        <h1>${esc(head)}</h1>
        <p class="page-lead">Each entry is checked against the profile its policy will get. Only exceptions move into site lists, one action per list and at most 750 sites each. Removals stay in the rollback snapshot.</p>
      </div>
      <div class="head-actions"><a class="btn btn-lg btn-primary" href="/design.html?tenant=${t}">Continue to design</a></div>
    </section>
    <section class="panel-card">
      <div class="card-head"><h2>Run the clean-up</h2><span class="spacer"></span>
        ${view.intelix ? '<span class="tag tag-ok">SophosLabs Intelix connected</span>' : '<a class="tag tag-warn" href="/credentials.html#intelix">No Intelix credential: add one</a>'}</div>
      <div class="cu-options">
        <label class="checkbox"><input type="checkbox" id="opt-dns" checked /> Check DNS (free)</label>
        <label class="checkbox"><input type="checkbox" id="opt-intelix"${view.intelix ? " checked" : " disabled"} /> Look up SophosLabs categories (Intelix bills each lookup)</label>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="run"${running ? " disabled" : ""}>${icon("play")}${run ? "Run again" : "Run the clean-up"}</button>
      </div>
      ${running ? `<div style="margin-top:14px"><p class="running-line" style="justify-content:flex-start"><span class="spinner"></span>Checked ${n(run.done)} of ${n(run.total)} entries</p><div class="bar"><div class="bar-fill is-live" style="width:${run.total ? (run.done / run.total) * 100 : 0}%"></div></div></div>` : ""}
      ${run?.intelixError ? `<div class="banner banner-warn" style="margin-top:12px">Intelix stopped: ${esc(run.intelixError)}</div>` : ""}
      ${run?.error ? `<div class="banner banner-err" style="margin-top:12px">${esc(run.error)}</div>` : ""}
      ${!view.intelix ? '<p class="hint" style="margin-top:10px">Without Intelix, entries that resolve are kept as exceptions until you decide them. Decide in the table, or export the CSV, decide there, and come back.</p>' : ""}
    </section>
    ${s ? `<section class="panel-card">${summaryHtml(s)}${listsHtml({ ...view, canCreate: true }, `/api/cleanup/${t}`)}</section>${tableHtml(view.results)}` : ""}
  `;
  main.querySelector("#run").addEventListener("click", async () => {
    try {
      await api.post(`/api/cleanup/${t}/run`, { dns: main.querySelector("#opt-dns").checked, intelix: main.querySelector("#opt-intelix").checked });
      load();
    } catch (err) {
      toast(err.message, "warn", 8000);
    }
  });
  if (view.results) wireView(main, view, { decisions: `/api/cleanup/${t}/decisions`, lists: `/api/cleanup/${t}/lists`, listBody: {} }, render);
  clearTimeout(timer);
  if (running) timer = setTimeout(load, 1500);
}

async function load() {
  try {
    const view = await api.get(`/api/cleanup/${encodeURIComponent(tenantId)}`);
    render(view);
  } catch (err) {
    main.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
  }
}

async function start() {
  await initShell();
  tenantId = currentTenantId();
  if (!tenantId) {
    window.location.href = getStatus()?.mode === "partner" ? "/estate.html" : "/";
    return;
  }
  const r = await api.get(`/api/readiness/${encodeURIComponent(tenantId)}`).catch(() => null);
  if (r?.tenant) {
    setTenant(r.tenant);
    document.title = `${r.tenant.name} · Clean up · Web Profiles Assistant`;
  }
  load();
}

start();
