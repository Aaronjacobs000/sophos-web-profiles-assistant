// Setup wizard: pick tenant or partner mode, test the credential, save it.

import { api } from "./api.js";
import { icon } from "./icons.js";
import { errorBanner, esc } from "./ui.js";
import { mark } from "./shell.js";

const $ = (s) => document.querySelector(s);
let tested = null;

$("#logo").innerHTML = mark("welcome-mark");
document.querySelectorAll("[data-icon]").forEach((el) => (el.innerHTML = icon(el.dataset.icon)));

function mode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function show(step) {
  document.querySelectorAll(".wizard-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.step !== String(step)));
  document.querySelectorAll("#wizard-steps li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("active", n === step);
    li.classList.toggle("done", n < step);
  });
}

function formValues() {
  const f = new FormData($("#cred-form"));
  return { mode: mode(), clientId: String(f.get("clientId") ?? "").trim(), clientSecret: String(f.get("clientSecret") ?? "").trim(), label: String(f.get("label") ?? "").trim() };
}

$("#to-2").addEventListener("click", () => {
  const partner = mode() === "partner";
  $("#cred-title").textContent = partner ? "Partner or organization API credential" : "Tenant API credential";
  $("#cred-help").textContent = partner
    ? "Paste the Client ID and Client Secret from Sophos Partner Care or the Enterprise dashboard. The secret is stored only in .env on this computer."
    : "Paste the Client ID and Client Secret. The secret is stored only in .env on this computer.";
  $("#label-row").querySelector(".hint").textContent = partner ? "(optional: your company name)" : "(the API doesn't return a tenant's name to a tenant credential)";
  $('#cred-form input[name="label"]').placeholder = partner ? "Example MSP" : "Contoso Legal";
  tested = null;
  $("#to-3").disabled = true;
  $("#test-result").innerHTML = "";
  show(2);
});

document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => show(Number(b.dataset.back))));

document.querySelector(".reveal-btn").addEventListener("click", (e) => {
  const input = e.currentTarget.parentElement.querySelector("input");
  input.type = input.type === "password" ? "text" : "password";
});

$("#cred-form").addEventListener("input", () => {
  tested = null;
  $("#to-3").disabled = true;
});

$("#test").addEventListener("click", async () => {
  const v = formValues();
  const out = $("#test-result");
  if (!v.clientId || !v.clientSecret) {
    out.innerHTML = `<div class="banner banner-warn">Enter both the Client ID and the Client Secret.</div>`;
    return;
  }
  out.innerHTML = `<p class="running-line"><span class="spinner"></span>Checking with Sophos</p>`;
  try {
    const r = await api.post("/api/credentials/test", v);
    tested = { ...v, result: r };
    out.innerHTML =
      r.idType === "tenant"
        ? `<div class="banner banner-ok">Connected to tenant <code>${esc(r.tenant.tenantId)}</code>${r.tenant.region ? `, region ${esc(r.tenant.region)}` : ""}.</div>`
        : `<div class="banner banner-ok">Connected as ${esc(r.idType)}. It reaches ${r.tenantCount} tenants.</div>`;
    $("#to-3").disabled = false;
  } catch (err) {
    out.innerHTML = errorBanner("The credential didn't connect.", err.message);
  }
});

$("#to-3").addEventListener("click", () => {
  if (!tested) return;
  const r = tested.result;
  $("#review").innerHTML = `<div class="review-card"><h3>${tested.mode === "partner" ? "Partner or organization" : "One tenant"}</h3><dl class="kv-list">
    <dt>Client ID</dt><dd><code>${esc(tested.clientId)}</code></dd>
    ${tested.label ? `<dt>Name</dt><dd>${esc(tested.label)}</dd>` : ""}
    ${r.idType === "tenant" ? `<dt>Tenant</dt><dd><code>${esc(r.tenant.tenantId)}</code></dd><dt>Region</dt><dd>${esc(r.tenant.region ?? "")}</dd>` : `<dt>Tenants</dt><dd>${r.tenantCount}</dd>`}
  </dl></div>`;
  show(3);
});

$("#save").addEventListener("click", async () => {
  const btn = $("#save");
  btn.disabled = true;
  // What was being saved when it failed, for the plain words in the banner.
  let saving = "credential";
  try {
    const r = await api.put("/api/credentials", { mode: tested.mode, clientId: tested.clientId, clientSecret: tested.clientSecret, label: tested.label });
    saving = "connect";
    if (r.status.status !== "configured-ok") throw new Error(r.status.error ?? "The credential was saved but didn't connect.");
    saving = "intelix";
    const ix = new FormData($("#ix-form"));
    const ixId = String(ix.get("ixId") ?? "").trim();
    const ixSecret = String(ix.get("ixSecret") ?? "").trim();
    if (ixId && ixSecret) await api.put("/api/intelix", { clientId: ixId, clientSecret: ixSecret, region: String(ix.get("ixRegion") ?? "au") });
    window.location.href = "/";
  } catch (err) {
    const plain = { credential: "Couldn't save the credential.", connect: "Saved, but the credential didn't connect.", intelix: "The credential is saved, but the Intelix credential couldn't be saved." }[saving];
    // Saved but not connected isn't red: the save worked and the check after it didn't confirm the credential.
    $("#review").insertAdjacentHTML("beforeend", errorBanner(plain, err.message, saving === "connect" ? "warn" : "err"));
    btn.disabled = false;
  }
});
