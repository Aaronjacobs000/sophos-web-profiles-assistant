// A small tenant inventory for the scorecard and snapshot tests, shaped like
// the live API answers saved during the 13/10/2026 retests.

const ok = (data) => ({ ok: true, data });

export function wcPolicy(over = {}) {
  const base = {
    id: "p-" + Math.random().toString(16).slice(2, 10),
    name: "Policy",
    type: "web-control",
    priority: 1,
    enabled: true,
    appliesTo: { users: [], userGroups: [] },
    settings: {
      "endpoint.web-control.web-profile.enabled": { value: false },
      "endpoint.web-control.web-profile-id": { value: "" },
      "endpoint.web-control.web-profile-log-web-events.enabled": { value: true },
      "endpoint.web-control.web-monitoring.enabled": { value: "yes" },
      "endpoint.web-control.web-filtering.enabled": { value: true },
      "endpoint.web-control.schedule.enabled": { value: false },
      "endpoint.web-control.web-profile-schedules": { value: [] },
      "endpoint.web-control.tags.settings": { value: [] },
      "endpoint.web-control.categories.0.action": { value: "allow" },
      "endpoint.web-control.categories.2.action": { value: "allow" },
      "endpoint.web-control.categories.10.action": { value: "allow" },
      "endpoint.web-control.categories.54.action": { value: "allow" },
    },
  };
  const merged = { ...base, ...over, settings: { ...base.settings, ...(over.settings ?? {}) } };
  return merged;
}

export function tpPolicy(over = {}) {
  const base = {
    id: "tp-" + Math.random().toString(16).slice(2, 10),
    name: "Base Policy",
    type: "threat-protection",
    priority: 0,
    enabled: true,
    appliesTo: { users: [], userGroups: [] },
    settings: {
      "endpoint.threat-protection.web-control.tls-decryption.enabled": { value: false },
      "endpoint.threat-protection.web-control.tls-decryption.quic.enabled": { value: false },
      "endpoint.threat-protection.malware-protection.web-filtering.enabled": { value: true, recommendedValue: true },
      "endpoint.threat-protection.malware-protection.web-scanning.enabled": { value: true, recommendedValue: true },
      "endpoint.threat-protection.exclusions.scanning": { value: [{ value: "C:\\temp\\", type: "path", scanMode: "onDemandAndOnAccess" }] },
      "endpoint.threat-protection.exploit-mitigation.enabled": { value: true },
    },
  };
  return { ...base, ...over, settings: { ...base.settings, ...(over.settings ?? {}) } };
}

export function device(id, platform, version, over = {}) {
  return {
    id,
    hostname: id.toUpperCase(),
    type: "computer",
    os: { platform, isServer: false },
    assignedProducts: version ? [{ code: "coreAgent", version, status: "installed" }] : [],
    ...over,
  };
}

export function inventory(over = {}) {
  return {
    tenant: { id: "00000000-0000-4000-a000-000000000001", name: "Contoso Legal", region: "au01", apiHost: "https://api-au01.central.sophos.com", credentialType: "tenant" },
    readAt: "2026-10-13T00:52:00.000Z",
    durationMs: 4200,
    calls: 21,
    endpoints: ok([device("a", "windows", "2026.2.2.1.0"), device("b", "windows", "2025.2.3.8.0"), device("c", "macOS", "2026.1.0.1")]),
    webControlPolicies: ok([wcPolicy({ name: "Base Policy", priority: 0 })]),
    serverWebControlPolicies: ok([]),
    threatProtectionPolicies: ok([tpPolicy()]),
    serverThreatProtectionPolicies: ok([]),
    localSites: ok([]),
    classicCategories: ok([{ id: 0, name: "UNCATEGORIZED", label: "Uncategorized" }]),
    tlsDecryption: ok({ categories: [{ id: 14, name: "Finance & Investment", decryptionEnabled: true }], excludedWebsites: { total: 0, items: [] }, excludedWebsiteItems: [] }),
    scanningExclusions: ok([]),
    profiles: ok([]),
    siteLists: ok([]),
    endpointGroups: ok([]),
    userGroups: ok([]),
    referencedUsers: ok({ ids: [], found: [] }),
    ...over,
  };
}

export { ok };
