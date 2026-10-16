// Small render helpers shared by the page scripts.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

export function escAttr(s) {
  return esc(s).replace(/'/g, "&#39;");
}

export function relTime(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The Build page's headline for the latest plan or build, in plain words rather than its status value. */
export function buildHeadline(rec, readOnly) {
  if (!rec) return "Plan the pilot";
  switch (rec.status) {
    case "dry-run":
      if (!rec.checks.every((c) => c.ok)) return "Dry run found problems";
      return readOnly ? "Dry run passed. Read-only mode, so nothing will be created." : `Dry run passed. Ready to create ${rec.steps.length} objects.`;
    case "built":
      return `Built ${rec.steps.length} objects`;
    case "partial":
      return "Build didn't finish";
    case "failed":
      return "Build failed";
    case "rolled-back":
      return "Rolled back";
    case "rollback-partial":
      return "Rollback didn't finish";
    default:
      return "Build";
  }
}

/** Text as a sentence: a message from Sophos, such as "Sophos API error 500: InternalServerError", often has no closing full stop. */
export function sentence(text) {
  const t = String(text ?? "").trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * What Sophos or the tool answered, on its own Detail line under a plain
 * message, so the message itself stays plain. Empty when there's no answer.
 */
export function detailHtml(raw) {
  const t = sentence(raw);
  return t ? `<span class="err-detail" data-error-detail>Detail: ${esc(t)}</span>` : "";
}

/** A banner that says plainly what went wrong, with what Sophos or the tool answered on a Detail line in it. */
export function errorBanner(plain, raw, variant = "err", style = "") {
  return `<div class="banner banner-${variant}"${style ? ` style="${style}"` : ""}>${esc(plain)}${detailHtml(raw)}</div>`;
}

/**
 * A read-back as recorded ("site listed", or "not read: " and why), split into its plain words and the answer for a
 * Detail line. An Allow that made its list adds what the profile read back after it.
 */
export function readBackParts(text) {
  const t = String(text ?? "");
  const m = /^not read: ([\s\S]+?)(; profile (?:links it as allow|read back without the link))?$/.exec(t);
  return m ? { plain: `not read${m[2] ?? ""}`, detail: m[1] } : { plain: t, detail: "" };
}

/**
 * Category C: the color a write's outcome gets is what was confirmed. Green only when a read-back confirmed it; amber
 * when Sophos accepted it but the read-back failed or disagreed, or only part of it went through; red when it failed and
 * nothing went through. The reason goes on a Detail line.
 */
export const OUTCOME_TOAST = { confirmed: "ok", unconfirmed: "warn", failed: "err" };
export const OUTCOME_TAG = { confirmed: "tag-ok", unconfirmed: "tag-warn", failed: "tag-bad" };

/** Why a write Sophos accepted isn't confirmed, from its read-back: what Sophos answered when it couldn't be read, else what was read. */
export function unconfirmedReason(readBack, fallback = "") {
  const back = readBackParts(readBack);
  return back.detail || fallback || (back.plain ? `Read back: ${back.plain}.` : "");
}

/** The note on a pilot whose rollback didn't finish: what it left in the tenant, why, and what to do next. */
export function rollbackUnfinishedBanner(pilot, tenantId) {
  const r = pilot?.rollbackUnfinished;
  if (!r) return "";
  const named = ["policy", "profile"].flatMap((k) => r.left.filter((s) => s.kind === k).map((s) => `the ${k} "${s.name}"`));
  const lists = r.left.filter((s) => s.kind === "site-list").length;
  const parts = [...named, ...(lists ? [plural(lists, "site list")] : [])];
  const left = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "the pilot";
  // Why it didn't finish, often what Sophos answered, goes on the Detail line. It can hold a long URL with an id, so it wraps anywhere.
  // A delete Sophos accepted that no read-back confirmed may have gone through, so the banner says what may be left.
  return `<div class="banner banner-warn" style="overflow-wrap:anywhere;margin-bottom:10px"><strong>The rollback didn't finish.</strong> These may still be in the tenant: ${esc(left)}.
    Roll it back again from the <a href="/build.html?tenant=${encodeURIComponent(tenantId)}">Build</a> page, or carry on with the pilot.${detailHtml(r.reason)}</div>`;
}

/** A retire record's status in plain words, for the Retired table and the messages after a retire or restore. */
export function retireStatus(status) {
  return { retired: "Retired", partial: "Retire didn't finish", failed: "Retire failed", restored: "Restored", "restore-partial": "Restore didn't finish" }[status] ?? "Retire";
}

/**
 * A retire step's status in plain words. A planned step in a record was never sent, because the retire stops at the
 * first failure. A failed step with a read-back was accepted by Sophos but not confirmed.
 */
export function retireStepStatus(status, readBack) {
  if (readBack && status === "failed") return "not confirmed";
  if (readBack && status === "restore-failed") return "restore not confirmed";
  return { planned: "not sent", done: "done", failed: "failed", restored: "restored", "restore-failed": "restore failed" }[status] ?? "unknown";
}
