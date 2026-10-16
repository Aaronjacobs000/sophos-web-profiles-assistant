// Credentials: see the saved credential (secret masked), test and save a new one.

import { api } from "./api.js";
import { initShell } from "./shell.js";
import { errorBanner, esc } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";

const main = document.getElementById("main");

function card(title, view, mode, active) {
  return `<section class="cred-card">
    <div class="card-head"><h2>${title}</h2>${active ? '<span class="tag tag-ok">In use</span>' : view.configured ? '<span class="tag tag-muted">Saved</span>' : '<span class="tag tag-muted">Not set</span>'}</div>
    ${view.configured ? `<dl class="kv-list"><dt>Client ID</dt><dd><code>${esc(view.clientId)}</code></dd><dt>Secret</dt><dd><code>${esc(view.clientSecretMasked)}</code></dd>${view.label ? `<dt>Name</dt><dd>${esc(view.label)}</dd>` : ""}</dl>` : `<p class="hint">No ${mode === "partner" ? "partner or organization" : "tenant"} credential saved.</p>`}
  </section>`;
}

function intelixHtml(ix) {
  return `<section class="panel-card" id="intelix" style="margin-top:16px">
    <div class="card-head"><h2>SophosLabs Intelix (optional)</h2>${ix.configured ? '<span class="tag tag-ok">Saved</span>' : '<span class="tag tag-muted">Not set</span>'}</div>
    <p class="card-sub">The clean-up step looks up each site's SophosLabs category with the Intelix URL lookup API. Subscribe to SophosLabs Intelix on AWS Marketplace to get a Client ID and Secret; Intelix bills each lookup (5,000 free a month at the time of writing), so the clean-up only looks up entries a policy acts on. A credential works in every region; pick the nearest. Without it, the clean-up still checks DNS and you decide entries by hand.</p>
    ${ix.configured ? `<dl class="kv-list" style="margin-bottom:12px"><dt>Client ID</dt><dd><code>${esc(ix.clientId)}</code></dd><dt>Secret</dt><dd><code>${esc(ix.clientSecretMasked)}</code></dd><dt>Region</dt><dd>${esc(ix.region)}</dd></dl>` : ""}
    <form id="ix" class="cred-form" autocomplete="off" style="max-width:560px">
      <label>Client ID<input type="text" name="clientId" spellcheck="false" /></label>
      <label>Client Secret<input type="password" name="clientSecret" /></label>
      <label>Region<select name="region"><option value="au"${ix.region === "au" ? " selected" : ""}>au (Australia)</option><option value="us"${ix.region === "us" ? " selected" : ""}>us</option><option value="de"${ix.region === "de" ? " selected" : ""}>de</option></select></label>
    </form>
    <div class="test-result" id="ix-out"></div>
    <div class="form-actions"><button class="btn" id="ix-test">Test (asks for a token, no lookup)</button><button class="btn btn-primary" id="ix-save">Save Intelix credential</button></div>
  </section>`;
}

async function render() {
  const status = await initShell();
  const [v, ix] = await Promise.all([api.get("/api/credentials"), api.get("/api/intelix")]);
  main.innerHTML = `
    <section class="page-head"><div><span class="eyebrow">Settings</span><h1>Credentials</h1>
      <p class="page-lead">The tool uses one credential at a time. Secrets stay in .env on this computer and are never shown in full.</p></div></section>
    ${status?.status === "configured-invalid" ? errorBanner("The saved credential didn't connect.", status.error, "err", "margin-bottom:16px") : ""}
    <div class="split-row" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      ${card("Tenant credential", v.tenant, "tenant", v.mode === "tenant" && status?.status === "configured-ok")}
      ${card("Partner or organization credential", v.partner, "partner", v.mode === "partner" && status?.status === "configured-ok")}
    </div>
    <section class="panel-card" style="margin-top:16px">
      <div class="card-head"><h2>Change the credential</h2></div>
      <form id="f" class="cred-form" autocomplete="off" style="max-width:560px">
        <div class="mode-picker mode-picker-row">
          <label class="mode-option"><input type="radio" name="mode" value="tenant"${v.mode === "tenant" ? " checked" : ""} /><div class="mode-card"><strong>One tenant</strong><p>Customers</p></div></label>
          <label class="mode-option"><input type="radio" name="mode" value="partner"${v.mode === "partner" ? " checked" : ""} /><div class="mode-card"><strong>Partner or organization</strong><p>Estates</p></div></label>
        </div>
        <label>Name to show <span class="hint">(optional)</span><input type="text" name="label" spellcheck="false" /></label>
        <label>Client ID<input type="text" name="clientId" spellcheck="false" required /></label>
        <label>Client Secret<div class="input-with-button"><input type="password" name="clientSecret" required /><button type="button" class="icon-btn reveal-btn" aria-label="Show secret" title="Show secret">${icon("eye")}</button></div></label>
      </form>
      <div class="test-result" id="out"></div>
      <div class="form-actions"><button class="btn" id="test">Test connection</button><button class="btn btn-primary" id="save">Save and connect</button></div>
    </section>
    ${intelixHtml(ix)}`;
  const f = main.querySelector("#f");
  const values = () => {
    const d = new FormData(f);
    return { mode: d.get("mode"), label: String(d.get("label") ?? "").trim(), clientId: String(d.get("clientId") ?? "").trim(), clientSecret: String(d.get("clientSecret") ?? "").trim() };
  };
  main.querySelector(".reveal-btn").addEventListener("click", (e) => {
    const input = e.currentTarget.parentElement.querySelector("input");
    input.type = input.type === "password" ? "text" : "password";
  });
  main.querySelector("#test").addEventListener("click", async () => {
    const out = main.querySelector("#out");
    out.innerHTML = `<p class="running-line" style="justify-content:flex-start"><span class="spinner"></span>Checking with Sophos</p>`;
    try {
      const r = await api.post("/api/credentials/test", values());
      out.innerHTML = `<div class="banner banner-ok">${r.idType === "tenant" ? `Connected to tenant <code>${esc(r.tenant.tenantId)}</code>.` : `Connected as ${esc(r.idType)}, ${r.tenantCount} tenants.`}</div>`;
    } catch (err) {
      out.innerHTML = errorBanner("The credential didn't connect.", err.message);
    }
  });
  main.querySelector("#save").addEventListener("click", async () => {
    const val = values();
    if (!val.clientId || !val.clientSecret) {
      toast("Enter the Client ID and Client Secret.", "warn");
      return;
    }
    try {
      const r = await api.put("/api/credentials", val);
      if (r.status.status === "configured-ok") {
        toast("Saved and connected.", "ok");
        window.location.href = "/";
      } else {
        // Saved, so not red: the save worked and the check after it didn't confirm the credential.
        main.querySelector("#out").innerHTML = errorBanner("Saved, but the credential didn't connect.", r.status.error, "warn");
      }
    } catch (err) {
      main.querySelector("#out").innerHTML = errorBanner("Couldn't save the credential.", err.message);
    }
  });
}

function wireIntelix() {
  const f = main.querySelector("#ix");
  const vals = () => {
    const d = new FormData(f);
    return { clientId: String(d.get("clientId") ?? "").trim(), clientSecret: String(d.get("clientSecret") ?? "").trim(), region: String(d.get("region") ?? "au") };
  };
  main.querySelector("#ix-test").addEventListener("click", async () => {
    const out = main.querySelector("#ix-out");
    out.innerHTML = '<p class="running-line" style="justify-content:flex-start"><span class="spinner"></span>Asking Intelix for a token</p>';
    try {
      const r = await api.post("/api/intelix/test", vals());
      out.innerHTML = `<div class="banner banner-ok">${esc(r.message)}</div>`;
    } catch (err) {
      out.innerHTML = errorBanner("Intelix didn't issue a token.", err.message);
    }
  });
  main.querySelector("#ix-save").addEventListener("click", async () => {
    const v = vals();
    if (!v.clientId) return toast("Enter the Intelix Client ID.", "warn");
    try {
      await api.put("/api/intelix", v);
      toast("Intelix credential saved.", "ok");
      show();
    } catch (err) {
      main.querySelector("#ix-out").innerHTML = errorBanner("Couldn't save the Intelix credential.", err.message);
    }
  });
}

/** Draws the page. When the saved credentials can't be read, the page says so in plain words. */
function show() {
  render()
    .then(wireIntelix)
    .catch((err) => {
      main.innerHTML = errorBanner("Couldn't read the saved credentials.", err.message);
    });
}

show();
