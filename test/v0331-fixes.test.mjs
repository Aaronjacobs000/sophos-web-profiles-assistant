// v0.3.31. A Web Control policy counted as on a web filtering profile when
// web-profile.enabled was true, one of the three settings the Web Filtering
// API guide sets together. A policy the API creates holds that setting true
// with filtering by profile off and no profile, so the readiness check called
// it a web profile policy, skipped its classic gaps and read the wrong logging
// setting, and the retire step muted it and left it out of the warnings,
// though it applies no profile. A policy now counts only with all three set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { usesWebProfile } from "../backend/dist/domain/inventory.js";
import { buildScorecard } from "../backend/dist/domain/scorecard.js";
import { previewRetire, retireOverview } from "../backend/dist/services/retire-service.js";
import { inventory, ok, wcPolicy } from "./fixtures.mjs";
import { Tenant, ctxOf, dataDirFor } from "./memory-tenant.mjs";

const EN = "endpoint.web-control.web-profile.enabled";
const FB = "endpoint.web-control.filter-by-web-profile.enabled";
const ID = "endpoint.web-control.web-profile-id";
const ON = { [EN]: { value: true }, [FB]: { value: true }, [ID]: { value: "prof-1" } };
const OFF = { [EN]: { value: false }, [FB]: { value: false }, [ID]: { value: "" } };

/** The three settings with only the named ones set, the rest as a live classic policy holds them. */
const withSet = (...keys) => Object.fromEntries([EN, FB, ID].map((k) => [k, keys.includes(k) ? ON[k] : OFF[k]]));
const policy = (settings) => ({ id: randomUUID(), name: "P", type: "web-control", priority: 1, enabled: true, settings });

test("a policy is on a web filtering profile only with all three settings set", () => {
  assert.equal(usesWebProfile(policy({})), false, "none of them");
  assert.equal(usesWebProfile(policy(withSet())), false, "all three off");
  for (const k of [EN, FB, ID]) assert.equal(usesWebProfile(policy(withSet(k))), false, `${k} alone`);
  for (const pair of [[EN, FB], [EN, ID], [FB, ID]]) assert.equal(usesWebProfile(policy(withSet(...pair))), false, `${pair.join(" and ")} only`);
  assert.equal(usesWebProfile(policy(withSet(EN, FB, ID))), true, "all three");
  assert.equal(usesWebProfile(policy({ ...ON, [ID]: { value: "  " } })), false, "a blank profile id is no profile");
  // What POST /endpoint/v1/policies with no settings holds, read live on 29/10/2026.
  assert.equal(usesWebProfile(policy({ [EN]: { value: true }, [FB]: { value: false }, [ID]: { value: "" } })), false, "a new policy from the API");
});

test("the readiness check shows a policy with one or two of the settings as classic", () => {
  const ads = { "endpoint.web-control.categories.2.action": { value: "block" }, "endpoint.web-control.web-monitoring.enabled": { value: "yes" }, "endpoint.web-control.web-profile-log-web-events.enabled": { value: false } };
  const sc = buildScorecard(
    inventory({
      webControlPolicies: ok([
        wcPolicy({ name: "One set", priority: 1, appliesTo: { users: ["u1"], userGroups: [] }, settings: { ...withSet(EN), ...ads } }),
        wcPolicy({ name: "Two set", priority: 2, appliesTo: { users: ["u2"], userGroups: [] }, settings: { ...withSet(EN, ID), [ID]: { value: "gone-2" }, ...ads } }),
        wcPolicy({ name: "All three", priority: 3, appliesTo: { users: ["u3"], userGroups: [] }, settings: { ...withSet(EN, FB, ID), [ID]: { value: "gone-3" }, ...ads } }),
        wcPolicy({ name: "Base Policy", priority: 0 }),
      ]),
      referencedUsers: ok({ ids: ["u1", "u2", "u3"], found: [{ id: "u1" }, { id: "u2" }, { id: "u3" }] }),
    }),
  );
  const mode = Object.fromEntries(sc.facts.policies.map((p) => [p.name, p.mode]));
  assert.deepEqual(mode, { "One set": "classic", "Two set": "classic", "All three": "profile", "Base Policy": "classic" });
  const item = (id) => sc.items.find((i) => i.id === id);
  assert.deepEqual(item("logging-off").evidence, ["All three"], "a half-set policy is read by its classic logging setting");
  assert.deepEqual(item("gap-check").evidence, ["One set: advertisements block", "Two set: advertisements block"], "a half-set policy still has its classic gaps checked");
  assert.deepEqual(item("missing-profile").evidence, ["All three"], "only a policy that applies a profile can point at a missing one");
});

test("retiring tags warns about a policy with one or two of the settings, and doesn't mute it", async () => {
  const dataDir = await dataDirFor("v0331");
  const tenant = new Tenant();
  const tags = { "endpoint.web-control.tags.settings": { value: [{ tag: "old", action: "allow" }] } };
  const target = (u) => ({ appliesTo: { users: [u], userGroups: [] } });
  const one = wcPolicy({ id: randomUUID(), name: "One set", priority: 1, ...target("u1"), settings: { ...withSet(EN), ...tags } });
  const two = wcPolicy({ id: randomUUID(), name: "Two set", priority: 2, ...target("u2"), settings: { ...withSet(EN, FB), ...tags } });
  const three = wcPolicy({ id: randomUUID(), name: "All three", priority: 3, ...target("u3"), settings: { ...withSet(EN, FB, ID), ...tags } });
  for (const p of [one, two, three]) tenant.policies.set(p.id, p);
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "a.example.com", tags: ["old"] });

  const overview = await retireOverview(dataDir, ctxOf(tenant));
  const onProfile = Object.fromEntries(overview.tags.find((t) => t.tag === "old").policies.map((p) => [p.name, p.onProfile]));
  assert.deepEqual(onProfile, { "One set": false, "Two set": false, "All three": true });

  const preview = await previewRetire(dataDir, ctxOf(tenant), ["old"]);
  const named = (n) => preview.warnings.some((w) => w.startsWith(`"${n}" still filters with classic settings`));
  assert.equal(named("One set"), true, "one setting");
  assert.equal(named("Two set"), true, "two settings");
  assert.equal(named("All three"), false, "all three");
  assert.equal(tenant.writes, 0, "both only read");
});
