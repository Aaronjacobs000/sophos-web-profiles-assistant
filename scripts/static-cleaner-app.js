// The static page's own code. Uses the inlined library: parseSite,
// inputsFromText, classify, siteListsFrom, summarise, resultsCsv,
// siteListCsv, IntelixClient, notWorthLookingUp, DEFAULT_CATALOG,
// expandPreset, PRESET_LABELS.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const catalog = DEFAULT_CATALOG;
  $("preset").innerHTML = catalog.presets.map((p) => `<option value="${esc(p.name)}">${esc(PRESET_LABELS[p.name] || p.name)}</option>`).join("");
  $("file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) $("text").value = await f.text();
  });
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  $("go").addEventListener("click", async () => {
    const out = $("out");
    const inputs = inputsFromText($("text").value, $("action").value, expandPreset(catalog, $("preset").value));
    if (!inputs.length) return (out.innerHTML = '<p class="err">Paste some sites first.</p>');
    const id = $("cid").value.trim();
    const secret = $("csecret").value.trim();
    const intelix = id && secret ? new IntelixClient({ clientId: id, clientSecret: secret, region: $("region").value }) : null;
    out.innerHTML = `<p class="hint">Classifying ${inputs.length} entries...</p>`;
    const cache = new Map();
    let stop = null;
    const seen = new Set();
    const results = [];
    for (const input of inputs) {
      const site = parseSite(input.raw);
      let lookup, lookupError;
      if (intelix && site.value && !notWorthLookingUp(site.host) && !stop) {
        const q = site.kind === "url" ? site.value : site.host;
        if (!cache.has(q)) cache.set(q, intelix.lookup(q).then((l) => ({ l }), (e) => ({ e: e.message, status: e.status })));
        const r = await cache.get(q);
        lookup = r.l;
        lookupError = r.e;
        if (r.status === 400 || r.status === 401) stop = r.e;
      }
      results.push(classify(input, catalog, { lookup, lookupError, seen }));
    }
    const s = summarise(results);
    const { lists, leftOut } = siteListsFrom(results, "Cleaned");
    out.innerHTML = `${stop ? `<p class="err">Intelix stopped: ${esc(stop)}</p>` : ""}
      <div class="counts"><span><b>${s.covered}</b> covered</span><span><b>${s.remove}</b> remove</span><span><b>${s.exception}</b> exceptions</span>${s.needsDecision ? `<span><b>${s.needsDecision}</b> need a decision</span>` : ""}</div>
      <div class="lists"><button id="all">All results (CSV)</button>${lists.map((l, i) => `<button data-list="${i}">${esc(l.name)}: ${l.sites.length} (CSV)</button>`).join("")}</div>
      ${leftOut.length ? `<p>${leftOut.length} ${leftOut.length === 1 ? "entry is" : "entries are"} left out of the site list CSVs: broad entries, and entries with different actions. Review them in the results CSV.</p>` : ""}
      <table><thead><tr><th>Site</th><th>Action</th><th>SophosLabs category</th><th>Risk</th><th>Verdict</th><th>Why</th></tr></thead><tbody>${results
        .map((r) => `<tr><td><b>${esc(r.site.value || r.raw)}</b></td><td>${esc(r.action)}</td><td>${esc(r.categoryLabel || (r.lookup && r.lookup.productivityCategory) || "")}</td><td>${esc((r.lookup && r.lookup.riskLevel) || "")}</td><td class="${r.verdict}">${r.verdict}${r.needsDecision ? " (decide)" : ""}</td><td>${esc(r.reason)}</td></tr>`)
        .join("")}</tbody></table>`;
    $("all").addEventListener("click", () => download("cleanup-results.csv", resultsCsv(results)));
    out.querySelectorAll("[data-list]").forEach((b) => b.addEventListener("click", () => {
      const l = lists[Number(b.dataset.list)];
      download(`${l.name.replace(/\s+/g, "-").toLowerCase()}.csv`, siteListCsv(l));
    }));
  });
})();
