/**
 * Working with profile categories: expanding a preset or a profile to one
 * action per category, compressing per-category actions back into a body the
 * API accepts, and reading a classic policy's category actions as profile
 * categories.
 *
 * The API's coverage rule (retested 13/10/2026): a custom profile must cover
 * every category exactly once, either through its group's action or by
 * listing every category of that group, plus "uncategorized". compress()
 * always produces a body that meets it.
 *
 * Pure: no Node or browser imports.
 */

import {
  CLASSIC_CATEGORIES,
  PRESETS,
  PROFILE_CATEGORIES,
  type FilterAction,
  type Preset,
  type ProfileCategory,
} from "./categories-data.js";

export type { FilterAction, Preset, ProfileCategory };
export type CategoryActions = Record<string, FilterAction>;

export interface Catalog {
  categories: ProfileCategory[];
  presets: Preset[];
}

export const DEFAULT_CATALOG: Catalog = { categories: PROFILE_CATEGORIES, presets: PRESETS };

/** The live metadata when it has the expected shape, else the built-in copy. */
export function catalogFrom(metadata: unknown): Catalog {
  const m = metadata as { categories?: ProfileCategory[]; presets?: Preset[] } | null;
  if (m && Array.isArray(m.categories) && m.categories.length > 0 && Array.isArray(m.presets) && m.presets.length > 0) {
    return {
      categories: m.categories,
      presets: m.presets.map((p) => ({ name: p.name, categoryGroupActions: p.categoryGroupActions ?? [], categoryActions: p.categoryActions ?? [] })),
    };
  }
  return DEFAULT_CATALOG;
}

export function labelOf(catalog: Catalog, name: string): string {
  return catalog.categories.find((c) => c.name === name)?.label ?? name;
}

export function groupOf(catalog: Catalog, name: string): string | undefined {
  return catalog.categories.find((c) => c.name === name)?.group;
}

export function groups(catalog: Catalog): string[] {
  return [...new Set(catalog.categories.map((c) => c.group).filter((g): g is string => !!g))].sort();
}

/** One action per category, from group actions with category actions on top. */
export function expand(
  catalog: Catalog,
  body: { categoryGroupActions?: Array<{ name: string; action: FilterAction }>; categoryActions?: Array<{ name: string; action: FilterAction }> },
): CategoryActions {
  const out: CategoryActions = {};
  const byGroup = new Map((body.categoryGroupActions ?? []).map((g) => [g.name, g.action]));
  for (const c of catalog.categories) {
    const g = c.group ? byGroup.get(c.group) : undefined;
    if (g) out[c.name] = g;
  }
  for (const a of body.categoryActions ?? []) out[a.name] = a.action;
  return out;
}

export function expandPreset(catalog: Catalog, presetName: string): CategoryActions {
  const preset = catalog.presets.find((p) => p.name === presetName);
  if (!preset) throw new Error(`Unknown preset "${presetName}".`);
  return expand(catalog, preset);
}

/** Per-category actions as a body that meets the coverage rule. Missing categories take `fallback`. */
export function compress(
  catalog: Catalog,
  actions: CategoryActions,
  fallback: FilterAction = "allow",
): { categoryGroupActions: Array<{ name: string; action: FilterAction }>; categoryActions: Array<{ name: string; action: FilterAction }> } {
  const categoryGroupActions: Array<{ name: string; action: FilterAction }> = [];
  const categoryActions: Array<{ name: string; action: FilterAction }> = [];
  for (const group of groups(catalog)) {
    const members = catalog.categories.filter((c) => c.group === group);
    const acts = members.map((c) => actions[c.name] ?? fallback);
    if (acts.every((a) => a === acts[0])) categoryGroupActions.push({ name: group, action: acts[0]! });
    else members.forEach((c, i) => categoryActions.push({ name: c.name, action: acts[i]! }));
  }
  for (const c of catalog.categories.filter((c) => !c.group)) {
    categoryActions.push({ name: c.name, action: actions[c.name] ?? fallback });
  }
  return { categoryGroupActions, categoryActions };
}

/** Categories where two sets of actions differ. */
export function differences(a: CategoryActions, b: CategoryActions, catalog: Catalog): string[] {
  return catalog.categories.map((c) => c.name).filter((n) => (a[n] ?? "allow") !== (b[n] ?? "allow"));
}

export interface ClassicReading {
  /** Profile categories with an action taken from a classic category. */
  actions: CategoryActions;
  /** Profile categories with no classic source; they take the nearest preset's action. */
  unmapped: string[];
  /** Classic categories that split into several profile categories, with the action they carried. */
  splits: Array<{ classicId: number; label: string; into: string[]; action: FilterAction }>;
  /** Classic categories set to block or warn that have no profile equivalent. */
  lost: Array<{ classicId: number; label: string; action: FilterAction; consider: string[] }>;
}

function asAction(v: unknown): FilterAction | "inherit" | undefined {
  return v === "allow" || v === "block" || v === "warn" || v === "inherit" ? v : undefined;
}

type Settings = Record<string, { value?: unknown } | undefined>;

/** One classic category's action in a policy: its own, or for "inherit" (or no setting) the Base policy's, then allow for "inherit". */
function classicAction(id: number, settings: Settings, baseSettings?: Settings): FilterAction | undefined {
  const key = `endpoint.web-control.categories.${id}.action`;
  const own = asAction(settings[key]?.value);
  if (own !== "inherit" && own !== undefined) return own;
  const base = asAction(baseSettings?.[key]?.value);
  return base && base !== "inherit" ? base : own === "inherit" ? "allow" : undefined;
}

/**
 * Classic categories with no action setting in Web Control policies that
 * classic blocks whatever the policy says: 34 Phishing & Fraud, 46 Spam URLs,
 * 48 Spyware. The policy settings list has no key for them (retested
 * 13/10/2026), and Help says a category override can't open a malicious
 * category. Website Management still accepts them as a category override,
 * which in effect always blocks the site. Inferred: Sophos hasn't said so.
 */
export const CLASSIC_ALWAYS_BLOCKED: ReadonlySet<number> = new Set([34, 46, 48]);

/** 56 Anonymizing Proxies and 57 Translation Services have no policy setting; policies set 37 Proxies & Translators. Inferred. */
const CLASSIC_FOLLOWS: Record<number, number> = { 56: 37, 57: 37 };

export interface OverrideAction {
  /** Undefined when nothing in the policy gives the category an action. */
  action?: FilterAction;
  how: "policy" | "always-blocked" | "follows-37" | "filtering-off" | "no-setting";
  label: string;
}

/**
 * What a Website Management category override does in one policy: the site
 * is treated as that classic category, so it gets the policy's action for it.
 */
export function classicOverrideAction(categoryId: number, settings: Settings, baseSettings: Settings | undefined, filtering: boolean): OverrideAction {
  const label = CLASSIC_CATEGORIES.find((c) => c.id === categoryId)?.label ?? `category ${categoryId}`;
  if (CLASSIC_ALWAYS_BLOCKED.has(categoryId)) return { action: "block", how: "always-blocked", label };
  if (!filtering) return { how: "filtering-off", label };
  const follows = CLASSIC_FOLLOWS[categoryId];
  const action = classicAction(follows ?? categoryId, settings, baseSettings);
  if (!action) return { how: "no-setting", label };
  return { action, how: follows ? "follows-37" : "policy", label };
}

/**
 * A classic policy's category actions as profile categories. "inherit" takes
 * the Base policy's action for that category, then allow.
 */
export function readClassic(
  catalog: Catalog,
  settings: Record<string, { value?: unknown } | undefined>,
  baseSettings?: Record<string, { value?: unknown } | undefined>,
): ClassicReading {
  const actions: CategoryActions = {};
  const splits: ClassicReading["splits"] = [];
  const lost: ClassicReading["lost"] = [];
  for (const cc of CLASSIC_CATEGORIES) {
    const a = classicAction(cc.id, settings, baseSettings);
    if (!a) continue;
    if (cc.profile.length === 0) {
      if (a !== "allow") lost.push({ classicId: cc.id, label: cc.label, action: a, consider: cc.also });
      continue;
    }
    if (cc.profile.length > 1) splits.push({ classicId: cc.id, label: cc.label, into: cc.profile, action: a });
    for (const p of cc.profile) {
      // Two classic categories can land on one profile category; the stricter wins.
      const prev = actions[p];
      actions[p] = !prev ? a : stricter(prev, a);
    }
  }
  const unmapped = catalog.categories.map((c) => c.name).filter((n) => !(n in actions));
  return { actions, unmapped, splits, lost };
}

const RANK: Record<FilterAction, number> = { allow: 0, warn: 1, block: 2 };
export function stricter(a: FilterAction, b: FilterAction): FilterAction {
  return RANK[a] >= RANK[b] ? a : b;
}
