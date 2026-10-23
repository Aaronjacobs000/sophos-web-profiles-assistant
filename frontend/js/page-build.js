// Build: the plan, a dry run, then site lists, a profile and a pilot
// policy at the top of the order, each read back. Builds can be rolled back,
// and the tenant compared with the snapshot taken before the build.

import { api } from "./api.js";
import { currentTenantId, getStatus, initShell, setTenant } from "./shell.js";
import { OUTCOME_TAG, OUTCOME_TOAST, buildHeadline, detailHtml, errorBanner, esc, escAttr, readBackParts, sentence, unansweredReason, unconfirmedReason } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { diffHtml } from "./diff-view.js";

const main = document.getElementById("main");
let tenantId = null;
let design = null;
let targets = null;
let lastPlan = null;
let builds = [];
let diff = null;

const REASON = { "windows-old-agent": "Windows below 2026.1", "windows-no-agent-version": "no agent version", macos: "macOS", other: "other platform" };
const KIND = { "site-list": "Site list", profile: "Profile", policy: "Policy" };
const READ_BACK = { matches: "matches", differs: "differs", "not-read": "not read" };

/**
 * A step's tag and the plain line under it (category C): Created is green only when the read-back matched what was
 * sent; amber when Sophos made it, or accepted its delete, but the read-back didn't confirm it, or didn't answer its
 * create with a success and nothing could be read to look for it; red when it failed. A delete Sophos didn't answer with
 * a success (a 5xx, a 404, or no answer) wasn't accepted, and the line says so. How it differed, or why it couldn't be
 * read, goes on the Detail line. A delete not confirmed says Roll back again only when a rollback has run for the step;
 * otherwise it's from an Allow undo, which is sent again from the Pilot page. A step Sophos didn't confirm was made says
 * what a rollback did when it looked for it by name: deleted it (Rolled back), found nothing (Nothing to remove, muted),
 * or couldn't read the tenant (amber).
 */
function stepState(s, rec) {
  const tag = (cls, label) => `<span class="tag ${cls}">${label}</span>`;
  // What the last rollback found for this step: why its delete failed, when it did.
  const rolled = rec.rollback?.steps.find((o) => o.id && o.id === s.id);
  const again = rolled ? "Roll back again, or check it in Sophos Fusion." : "Undo the Allow again on the Pilot page, or check it in Sophos Fusion.";
  switch (s.status) {
    case "planned":
      return { tag: tag("tag-muted", "Dry run OK") };
    case "created":
      if (s.readBack === "matches") return { tag: tag(OUTCOME_TAG.confirmed, "Created") };
      return {
        tag: tag(OUTCOME_TAG.unconfirmed, "Not confirmed"),
        note: s.readBack === "differs" ? "Sophos made it, but it didn't read back as sent." : s.readBack === "not-read" ? "Sophos made it, but the tool couldn't read it back, so it isn't confirmed." : "Sophos made it, but it isn't confirmed.",
        detail: s.readBackNote ?? (s.readBack ? "" : "No read-back on record."),
      };
    case "unconfirmed": {
      // Sophos didn't answer the create with a success, and nothing could be read to look for it by name: it may be there.
      // A rollback looks for it by name: one that couldn't read the tenant says so, and one from before v0.3.25 didn't look.
      const looked = rec.rollback?.steps.find((o) => o.lookedUp === "not read" && o.kind === s.kind && o.name === s.name);
      if (looked) return { tag: tag(OUTCOME_TAG.unconfirmed, "Not confirmed"), note: LOOKUP_UNREAD_NOTE, detail: `${sentence(s.answer)} ${sentence(looked.error)}`.trim() };
      return { tag: tag(OUTCOME_TAG.unconfirmed, "Not confirmed"), note: rec.rollback ? NOT_LOOKED_NOTE : UNCONFIRMED_NOTE, detail: unansweredReason(s.answer, `not read: ${s.readBackNote ?? ""}`) };
    }
    case "not-found":
      return { tag: tag("tag-muted", "Nothing to remove"), note: NOT_FOUND_NOTE };
    case "failed":
      return { tag: tag(OUTCOME_TAG.failed, "Failed"), note: s.error ? "This step failed, so the build stopped here." : "", detail: s.error };
    case "deleted":
      return { tag: tag("tag-muted", "Rolled back") };
    case "delete-failed":
      if (s.deleteReadBack && s.deleteAnswer) {
        const back = readBackParts(s.deleteReadBack);
        return { tag: tag(OUTCOME_TAG.unconfirmed, "Delete not confirmed"), note: `Sophos didn't say the delete went through, and the read-back didn't confirm it's gone. ${again}`, detail: `${sentence(s.deleteAnswer)} Read back: ${sentence(back.detail || back.plain)}` };
      }
      if (s.deleteReadBack) return { tag: tag(OUTCOME_TAG.unconfirmed, "Delete not confirmed"), note: `Sophos accepted the delete, but the read-back didn't confirm it's gone. ${again}`, detail: unconfirmedReason(s.deleteReadBack) };
      // An Allow undo's delete of the pilot allows list that a read-back still found keeps why on the step; a rollback's is in the rollback.
      if (s.deleteError) return { tag: tag(OUTCOME_TAG.failed, "Delete failed"), note: "The delete failed. Undo the Allow again on the Pilot page, or check it in Sophos Fusion.", detail: s.deleteError };
      return { tag: tag(OUTCOME_TAG.failed, "Delete failed"), note: rolled?.error ? "The delete failed. Roll back again, or check it in Sophos Fusion." : "", detail: rolled?.error };
    default:
      return { tag: "" };
  }
}

// A create Sophos didn't answer with a success, with nothing read after to look for it: it may be in the tenant.
const UNCONFIRMED_NOTE = "Sophos didn't say it was made, and the read-back didn't confirm it. The next build looks for it by name first and uses it if it's there.";
// What a rollback did with one: couldn't read the tenant to look for it, didn't look (before v0.3.25), or found nothing.
const LOOKUP_UNREAD_NOTE = "Sophos didn't say it was made, and the rollback couldn't look for it by name, so it may be in the tenant. Roll back again, or check for it in Sophos Fusion.";
const NOT_LOOKED_NOTE = "Sophos didn't say it was made, and the last rollback didn't look for it. Roll back again: it looks for it by name and deletes it if it's there.";
const NOT_FOUND_NOTE = "Sophos didn't say it was made, and the rollback found nothing by that name, so there was nothing to remove.";

/** What a step's read-back didn't confirm, for the Detail line of a message. */
function stepReason(s) {
  return `${KIND[s.kind] ?? "Object"} "${s.name}": ${s.readBackNote ? sentence(s.readBackNote) : s.readBack === "differs" ? "it didn't read back as sent." : "no read-back on record."}`;
}

/**
 * A build's outcome (category C): green only when every object it made read back as sent; amber when it built but a
 * read-back didn't confirm an object, or it stopped part way; red when it made nothing. The reason goes on the Detail line.
 */
function buildOutcome(rec) {
  const created = rec.steps.filter((s) => s.status === "created");
  if (rec.status === "built") {
    const open = created.filter((s) => s.readBack !== "matches");
    if (!open.length) return { state: "confirmed", text: "Built and read back.", reason: "" };
    const which = open.length === 1 ? `the ${(KIND[open[0].kind] ?? "object").toLowerCase()} "${open[0].name}"` : `${open.length} of the ${created.length} objects`;
    return { state: "unconfirmed", text: `Built, but the read-back didn't confirm ${which}.`, reason: open.map(stepReason).join(" ") };
  }
  // A create Sophos didn't answer with a success, with nothing read after to look for it, may have been made.
  const unknown = rec.steps.find((s) => s.status === "unconfirmed");
  if (unknown) return { state: "unconfirmed", text: `${buildHeadline(rec)}. Sophos didn't say the ${(KIND[unknown.kind] ?? "object").toLowerCase()} "${unknown.name}" was made, and the read-back didn't confirm it.`, reason: unansweredReason(unknown.answer, `not read: ${unknown.readBackNote ?? ""}`) };
  const failed = rec.steps.find((s) => s.status === "failed");
  const check = rec.checks.find((c) => !c.ok);
  const reason = failed?.error ? sentence(failed.error) : check ? [check.text, check.detail].filter(Boolean).map(sentence).join(" ") : "";
  return { state: created.length ? "unconfirmed" : "failed", text: `${buildHeadline(rec)}.`, reason };
}

/**
 * A rollback's outcome (category C): green only when every object read back gone and Website Management read back as
 * the snapshot has it; amber when Sophos accepted part or all of it, or didn't answer a delete with a success, but a
 * read-back didn't confirm it; red when nothing it sent went through. It says Sophos accepted the rollback only when
 * Sophos answered every delete the read-back didn't confirm with a success. The reason goes on the Detail line. A step
 * Sophos didn't confirm was made is looked for by name: the message says what was found and deleted, or wasn't there,
 * and it's amber when the tenant couldn't be read to look, since that confirms neither.
 */
function rollbackOutcome(rec) {
  const steps = rec.rollback?.steps ?? [];
  // A step Sophos didn't confirm was made (no id) is looked for by name: what the rollback found, or that it couldn't look.
  const looked = lookedUpText(steps);
  if (rec.status === "rolled-back") return { state: "confirmed", text: `${buildHeadline(rec)}.${looked}`, reason: "" };
  const failed = steps.find((o) => o.status === "failed");
  const unread = steps.filter((o) => o.lookedUp === "not read");
  const opens = steps.filter((o) => (o.status === "not confirmed" || o.status === "still there after delete") && o.lookedUp !== "not read");
  const open = opens[0];
  const why = (o) => `${o.name}: ${sentence(o.error ?? "It was still there after the delete.")}`;
  if (!failed && unread.length) {
    const kind = (KIND[unread[0].kind] ?? "object").toLowerCase();
    const text = unread.length === 1
      ? `The rollback couldn't confirm whether the ${kind} "${unread[0].name}" is in the tenant: Sophos didn't confirm it was made, and the rollback couldn't look for it by name. Check for it in Sophos Fusion, or roll back again.`
      : `The rollback couldn't confirm whether ${unread.length} objects Sophos didn't confirm were made are in the tenant: it couldn't look for them by name. Check for them in Sophos Fusion, or roll back again.`;
    return { state: "unconfirmed", text: `${text}${opens.length ? " The read-back didn't confirm all of the rest either." : ""}${looked}`, reason: [...unread, ...opens].map(why).join(" ") };
  }
  // A delete Sophos answered with a 5xx or a 404, or not at all, wasn't accepted (its step keeps what Sophos said), nor was a Website Management change it gave no success to (answer).
  const unansweredOpens = opens.filter((o) => o.answer || (o.id && rec.steps.some((s) => s.id === o.id && s.deleteAnswer)));
  const unanswered = unansweredOpens.length;
  const what = unansweredOpens.every((o) => o.kind !== "website-management") ? "delete" : "change";
  if (!failed && open && unanswered) return { state: "unconfirmed", text: `The rollback isn't confirmed: Sophos didn't say ${unanswered === 1 ? `a ${what}` : `${unanswered} ${what}s`} went through, and the read-back didn't confirm ${unanswered === 1 ? "it" : "them"}.${looked}`, reason: why(open) };
  if (!failed && open) return { state: "unconfirmed", text: `Sophos accepted the rollback, but the read-back didn't confirm all of it.${looked}`, reason: why(open) };
  return { state: steps.some((o) => o.status !== "failed") ? "unconfirmed" : "failed", text: `${buildHeadline(rec)}.${looked}`, reason: [failed ?? open, ...unread].filter(Boolean).map(why).join(" ") };
}

/** What a rollback did with each step it looked for by name and settled: found and deleted, or not in the tenant. */
function lookedUpText(steps) {
  return steps
    .filter((o) => (o.lookedUp === "found" && o.status.startsWith("deleted")) || o.lookedUp === "not found")
    .map((o) => ` The ${(KIND[o.kind] ?? "object").toLowerCase()} "${o.name}", which Sophos didn't confirm was made, ${o.lookedUp === "found" ? "was found by name and deleted" : "isn't in the tenant, so there was nothing to remove"}.`)
    .join("");
}

/** Says what a build or rollback did, and that the list of builds couldn't be read after it when that failed: amber at best, with both reasons. */
function outcomeToast(o, listError, what) {
  if (listError === undefined) return toast(o.text, OUTCOME_TOAST[o.state], o.state === "confirmed" ? 9000 : 10000, o.reason);
  toast(`${o.text} The list of builds couldn't be read again, so it doesn't show ${what} yet.`, OUTCOME_TOAST[o.state === "failed" ? "failed" : "unconfirmed"], 10000, [o.reason, sentence(listError)].filter(Boolean).join(" "));
}

function pilotFromForm() {
  const f = main.querySelector("#pilot");
  const checked = (name) => [...f.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  return {
    profileKey: f.querySelector("#profile").value,
    name: f.querySelector("#pname").value,
    enabled: f.querySelector("#enabled").checked,
    targets: { endpoints: checked("endpoints"), endpointGroups: checked("endpointGroups"), userGroups: checked("userGroups") },
  };
}

function stepsHtml(rec) {
  return `<ol class="steps-list">${rec.steps
    .map(
      (s) => {
        const st = stepState(s, rec);
        return `<li><span class="s-n">${s.order}</span><div><div class="s-name">${esc(KIND[s.kind] ?? "Policy")} "${esc(s.name)}"</div>
        <div class="s-sum">${esc(s.summary)}${s.readBack ? `. Read back: ${esc(READ_BACK[s.readBack] ?? s.readBack)}` : ""}${s.note ? `. ${esc(s.note)}` : ""}</div>
        ${st.note ? `<span class="err-note">${st.note}</span>` : ""}${detailHtml(st.detail)}
        <div class="s-path">${s.method} ${esc(s.path)}${s.id ? `  ${esc(s.id)}` : ""}</div></div>${st.tag}</li>`;
      },
    )
    .join("")}</ol>`;
}

// Builds saved before v0.3.17 kept what Sophos or the tool answered in the check's own words: the words stay, the answer goes on the Detail line.
const CHECK_DETAIL = [/^(Couldn't check the targets): ([\s\S]+)$/, /^(No rollback snapshot could be saved, so nothing was built\.) ([\s\S]+)$/];

function checkHtml(c) {
  const m = c.detail ? null : CHECK_DETAIL.map((re) => re.exec(c.text)).find(Boolean);
  const text = m ? `${m[1].replace(/\.$/, "")}.` : c.text;
  return `<li class="${c.level}"><span>${esc(text)}${detailHtml(c.detail ?? m?.[2])}</span></li>`;
}

function checksHtml(rec) {
  return `<ul class="check-list">${rec.checks.map(checkHtml).join("")}</ul>`;
}

function render() {
  const t = encodeURIComponent(tenantId);
  const profiles = design.profiles;
  const lead = lastPlan;
  const devices = targets.endpoints;
  main.innerHTML = `
    <section class="page-head">
      <div><span class="eyebrow">Build${lead ? `: ${esc(lead.pilot.name)}` : ""}</span>
        <h1>${esc(buildHeadline(lead, getStatus()?.readOnly))}</h1>
        <p class="page-lead">Site lists, then the profile, then a pilot policy at the top of the policy order with the profile, logging on and Recommended file types. A rollback snapshot is saved first. Every write is sent once, read back, and recorded in the audit log.</p></div>
      <div class="head-actions">
        <button class="btn btn-lg" id="dry">${icon("search")}Dry run</button>
        <button class="btn btn-lg btn-primary" id="go" data-write${lead && lead.status === "dry-run" && lead.checks.every((c) => c.ok) ? "" : " disabled"}>${icon("play")}Create ${lead?.steps.length ?? ""} objects</button>
      </div>
    </section>
    <div class="build-grid">
      <section class="panel-card">
        <h2>Pilot policy</h2>
        <form id="pilot" class="form-stack" onsubmit="return false">
          <label>Profile<select id="profile">${profiles.map((p) => `<option value="${escAttr(p.key)}">${esc(p.name)}</option>`).join("")}</select></label>
          <label>Policy name<input type="text" id="pname" placeholder="WF pilot: profile name" /></label>
          <label class="checkbox"><input type="checkbox" id="enabled" checked /> Enabled (turn off to build it without changing devices yet)</label>
          <label>Devices (Windows on 2026.1 or later can use profiles)
            <div class="target-list">${devices.map((d) => d.kind === "server" ? `<label class="muted"><input type="checkbox" name="endpoints" value="${escAttr(d.id)}" disabled /> ${esc(d.hostname)}<span class="hint">server: needs a server policy</span></label>` : `<label><input type="checkbox" name="endpoints" value="${escAttr(d.id)}" /> ${esc(d.hostname)}<span class="hint">${d.eligible ? "eligible" : esc(REASON[d.reason] ?? d.reason)}</span></label>`).join("") || '<span class="hint">No devices.</span>'}</div></label>
          <label>Device groups
            <div class="target-list">${targets.endpointGroups.map((g) => g.type === "server" ? `<label class="muted"><input type="checkbox" name="endpointGroups" value="${escAttr(g.id)}" disabled /> ${esc(g.name)}<span class="hint">server group: needs a server policy</span></label>` : `<label><input type="checkbox" name="endpointGroups" value="${escAttr(g.id)}" /> ${esc(g.name)}<span class="hint">${g.members ?? "?"} devices</span></label>`).join("") || '<span class="hint">No device groups.</span>'}</div></label>
          <label>User groups (a policy goes to devices or to users, not both)
            <div class="target-list">${targets.userGroups.map((g) => `<label><input type="checkbox" name="userGroups" value="${escAttr(g.id)}" /> ${esc(g.name)}<span class="hint">${g.members ?? "?"} users</span></label>`).join("") || '<span class="hint">No user groups.</span>'}</div></label>
        </form>
      </section>
      <div class="score-main">
        ${lead ? `<section class="panel-card"><h2>Plan</h2>${stepsHtml(lead)}</section><section class="panel-card"><h2>Checks</h2>${checksHtml(lead)}</section>` : '<section class="panel-card"><p class="muted">Choose the profile and pilot targets, then run a dry run. Nothing is written until you confirm.</p></section>'}
        ${diffHtml(diff)}
        <section class="panel-card"><h2>Builds</h2>${
          builds.length
            ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Pilot</th><th>Status</th><th>Snapshot</th><th></th></tr></thead><tbody>${builds
                .map((b) => `<tr><td class="cell-nowrap">${new Date(b.createdAt).toLocaleString("en-GB")}</td><td>${esc(b.pilot.name)}</td><td>${esc(buildHeadline(b))}</td><td><code>${esc(b.snapshotFile ?? "")}</code></td><td class="cell-nowrap">
                  ${["built", "partial", "rollback-partial"].includes(b.status) ? `<button class="btn btn-small btn-danger" data-rollback="${escAttr(b.id)}">Roll back</button>` : ""}
                  ${b.snapshotFile ? `<button class="btn btn-small" data-diff="${escAttr(b.snapshotFile)}">Compare with snapshot</button>` : ""}</td></tr>`)
                .join("")}</tbody></table></div>`
            : '<p class="muted">No builds yet.</p>'
        }</section>
      </div>
    </div>`;
  if (lead) {
    main.querySelector("#profile").value = lead.pilot.profileKey;
    main.querySelector("#pname").value = lead.pilot.name;
    main.querySelector("#enabled").checked = lead.pilot.enabled;
    for (const [k, ids] of Object.entries(lead.pilot.targets)) for (const id of ids ?? []) {
      const box = main.querySelector(`input[name="${k}"][value="${CSS.escape(id)}"]`);
      if (box) box.checked = true;
    }
  }
  main.querySelector("#dry").addEventListener("click", async () => {
    try {
      lastPlan = await api.post(`/api/build/${t}/dry-run`, pilotFromForm());
      diff = null;
      render();
    } catch (err) {
      toast("Couldn't run the dry run.", "warn", 9000, err.message);
    }
  });
  main.querySelector("#go").addEventListener("click", async () => {
    if (!window.confirm(`Create ${lastPlan.steps.length} objects in ${tenantId}? A rollback snapshot is saved first.`)) return;
    const btn = main.querySelector("#go");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Building';
    try {
      lastPlan = await api.post(`/api/build/${t}/execute`, pilotFromForm());
    } catch (err) {
      toast("Couldn't build the pilot.", OUTCOME_TOAST.failed, 10000, err.message);
      render();
      return;
    }
    // The build has answered. A read of the builds list after it that fails doesn't change what the build did, so the toast says both.
    const outcome = buildOutcome(lastPlan);
    try {
      builds = (await api.get(`/api/build/${t}`)).items;
    } catch (err) {
      render();
      outcomeToast(outcome, err.message, "this build");
      return;
    }
    render();
    outcomeToast(outcome);
  });
  main.querySelectorAll("[data-rollback]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const plan = await api.post(`/api/build/${t}/${b.dataset.rollback}/rollback`, { dryRun: true });
        const objs = plan.steps.filter((s) => s.id && s.status !== "deleted");
        // Steps Sophos didn't confirm were made have no id: the rollback looks for them by name.
        const asked = plan.steps.filter((s) => s.status === "unconfirmed" && !s.id);
        const wm = plan.restorePlan?.length ?? 0;
        const does = [...(objs.length || !asked.length ? [`delete ${objs.map((s) => `${s.kind} "${s.name}"`).join(", ")} in that order`] : []), ...(asked.length ? [`look for ${asked.map((s) => `${s.kind} "${s.name}"`).join(", ")} by name, which Sophos didn't confirm ${asked.length === 1 ? "was" : "were"} made, and delete ${asked.length === 1 ? "it" : "them"} if there`] : [])];
        if (!window.confirm(`Roll back: ${does.join(", and ")}${wm ? `, and ${wm} Website Management changes from the snapshot` : ""}?${plan.restoreRefused ? `\n\n${plan.restoreRefused}` : ""}`)) return;
        lastPlan = await api.post(`/api/build/${t}/${b.dataset.rollback}/rollback`, { dryRun: false });
      } catch (err) {
        toast("Couldn't roll back the build.", OUTCOME_TOAST.failed, 10000, err.message);
        return;
      }
      // The rollback has answered. A read of the builds list after it that fails doesn't change what the rollback did, so the toast says both.
      const outcome = rollbackOutcome(lastPlan);
      try {
        builds = (await api.get(`/api/build/${t}`)).items;
      } catch (err) {
        render();
        outcomeToast(outcome, err.message, "the rollback");
        return;
      }
      render();
      outcomeToast(outcome);
    }),
  );
  main.querySelectorAll("[data-diff]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.innerHTML = '<span class="spinner"></span>Reading';
      try {
        diff = await api.post(`/api/diff/${t}`, { snapshotFile: b.dataset.diff });
        render();
      } catch (err) {
        toast("Couldn't compare with the snapshot.", "warn", 10000, err.message);
        render();
      }
    }),
  );
}

async function start() {
  await initShell();
  tenantId = currentTenantId();
  if (!tenantId) {
    window.location.href = getStatus()?.mode === "partner" ? "/estate.html" : "/";
    return;
  }
  const t = encodeURIComponent(tenantId);
  const r = await api.get(`/api/readiness/${t}`).catch(() => null);
  if (r?.tenant) setTenant(r.tenant);
  main.innerHTML = '<p class="running-line"><span class="spinner"></span>Reading the design and pilot targets</p>';
  try {
    [design, targets, builds] = await Promise.all([api.get(`/api/design/${t}`).then((x) => x.design), api.get(`/api/pilot-targets/${t}`), api.get(`/api/build/${t}`).then((x) => x.items)]);
    lastPlan = builds[0] ?? null;
    render();
  } catch (err) {
    main.innerHTML = errorBanner("Couldn't read the design and pilot targets.", err.message);
  }
}

start();
