// The site list cleaner (concept 3): paste a list, load a CSV, or read
// Website Management, and get Covered, Exception or Remove for each entry,
// compared with a preset. Exports CSVs ready for site lists.

import { api } from "./api.js";
import { getStatus, initShell } from "./shell.js";
import { esc, escAttr } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { listsHtml, summaryHtml, tableHtml, wireView } from "./cleanup-view.js";

const main = document.getElementById("main");
let presets = [];
let lastText = "";

function render(view) {
  const status = getStatus();
  const connected = status?.status === "configured-ok";
  const tenants = connected ? (status.mode === "tenant" ? [{ id: status.tenant.tenantId, name: status.tenant.displayName }] : []) : [];
  const opts = view?.run?.options ?? {};
  main.innerHTML = `
    <section class="page-head"><div><span class="eyebrow">Tools</span><h1>Site list cleaner</h1>
      <p class="page-lead">Paste sites, load a CSV, or read Website Management. Each entry comes back Covered, Exception or Remove with the reason, compared with the preset you pick. Export the exceptions as site lists of up to 750 sites, one action per list.</p></div></section>
    <section class="panel-card cu-input">
      <div class="cu-input-grid">
        <div class="stack">
          <label>Sites, one per line, or a CSV with site, action and tags columns
            <textarea id="text" spellcheck="false" placeholder="example.com&#10;*.contoso-files.example&#10;https://promo2019.contoso.example/landing">${esc(lastText)}</textarea></label>
          <div class="cu-options">
            <label class="btn btn-small" style="cursor:pointer">${icon("download")}Load a CSV<input type="file" id="file" accept=".csv,.txt,text/csv,text/plain" hidden /></label>
            ${connected ? `<button class="btn btn-small" id="from-wm">${icon("refresh")}Read Website Management${tenants[0] ? ` (${esc(tenants[0].name)})` : ""}</button>` : '<span class="hint">Connect a tenant to read Website Management.</span>'}
          </div>
        </div>
        <div class="stack form-stack">
          <label>Action for pasted sites<select id="action"><option value="block">Block</option><option value="allow">Allow</option><option value="warn">Warn</option></select></label>
          <label>Compare with the preset<select id="preset">${presets.map((p) => `<option value="${escAttr(p.name)}"${(opts.preset ?? "keep-it-clean") === p.name ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
          <label class="checkbox"><input type="checkbox" id="dns" checked /> Check DNS</label>
          <label class="checkbox"><input type="checkbox" id="intelix"${view?.intelix ? " checked" : " disabled"} /> SophosLabs Intelix lookups${view?.intelix ? "" : ' <a href="/credentials.html#intelix">(add a credential)</a>'}</label>
          <button class="btn btn-primary" id="go">${icon("play")}Classify</button>
        </div>
      </div>
    </section>
    ${view?.summary ? `<section class="panel-card">${summaryHtml(view.summary)}${listsHtml({ ...view, canCreate: connected && status.mode === "tenant" }, "/api/cleaner")}</section>${tableHtml(view.results)}` : ""}
    <p class="hint">A single-file copy of the paste-and-classify half, which calls Intelix only and needs no server, is built with <code>npm run build:cleaner</code>. Intelix allows the browser calls, so it works opened as a file or from any web server. It isn't hosted anywhere.</p>
  `;
  const textEl = main.querySelector("#text");
  textEl.addEventListener("input", () => (lastText = textEl.value));
  if (opts.defaultAction) main.querySelector("#action").value = opts.defaultAction;
  main.querySelector("#file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    lastText = await f.text();
    textEl.value = lastText;
    toast(`Loaded ${f.name}.`, "ok");
  });
  const classify = async (body) => {
    const btn = main.querySelector("#go");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Classifying';
    try {
      render(await api.post("/api/cleaner/classify", body));
    } catch (err) {
      toast(err.message, "warn", 9000);
      btn.disabled = false;
      btn.innerHTML = `${icon("play")}Classify`;
    }
  };
  const common = () => ({ preset: main.querySelector("#preset").value, defaultAction: main.querySelector("#action").value, dns: main.querySelector("#dns").checked, intelix: main.querySelector("#intelix").checked });
  main.querySelector("#go").addEventListener("click", () => classify({ ...common(), text: textEl.value }));
  main.querySelector("#from-wm")?.addEventListener("click", () => classify({ ...common(), tenantId: tenants[0]?.id ?? "self" }));
  if (view?.results) wireView(main, view, { decisions: "/api/cleaner/decisions", lists: "/api/cleaner/lists", listBody: { tenantId: tenants[0]?.id ?? "self" } }, render);
}

async function start() {
  await initShell({ allowUnconfigured: true });
  const status = getStatus();
  const tenant = status?.mode === "tenant" ? status.tenant?.tenantId : null;
  presets = (await api.get(`/api/presets${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`)).items;
  render(await api.get("/api/cleaner"));
}

start();
