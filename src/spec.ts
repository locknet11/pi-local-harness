/**
 * PROJECT_SPEC.md — the feature backlog.
 *
 * Features are addressed by block index, never by name. Two features with
 * similar names (or a name containing regex metacharacters, which a model will
 * produce sooner or later) must never be able to make the harness rewrite the
 * status of the wrong block.
 *
 * Canonical format:
 *
 *   ## feature: Short imperative name
 *   id: F001
 *   status: PENDING
 *   depends: none
 *   test: npm test -- tests/foo        (optional, overrides the global command)
 *   acceptance:
 *     - observable, verifiable criterion
 *   notes: |
 *     free-form implementation detail
 */
import { readFileSync, writeFileSync } from "node:fs";

export const FEATURE_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "UNVERIFIED",
  "FAILED",
  "BLOCKED",
] as const;

export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface Feature {
  /** 1-based block index; the stable address of this feature. */
  index: number;
  name: string;
  id: string;
  status: FeatureStatus | string;
  depends: string[];
  test?: string;
  acceptance: string[];
  notes?: string;
  /** 0-based line of the `status:` line, for surgical rewrites. */
  statusLineNo: number;
  /** Full block text, handed to the model as the task description. */
  raw: string;
}

const FEATURE_RE = /^#*\s*feature:\s*(.*)$/i;
const FIELD_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;

export function parseSpec(text: string): Feature[] {
  const lines = text.split("\n");
  const features: Feature[] = [];
  let current: Feature | null = null;
  let currentStart = 0;
  let collecting: "acceptance" | "notes" | null = null;

  const close = (endLine: number) => {
    if (!current) return;
    current.raw = lines.slice(currentStart, endLine).join("\n").trimEnd();
    features.push(current);
    current = null;
    collecting = null;
  };

  lines.forEach((line, i) => {
    const featureMatch = FEATURE_RE.exec(line);
    if (featureMatch) {
      close(i);
      currentStart = i;
      current = {
        index: features.length + 1,
        name: (featureMatch[1] ?? "").trim(),
        id: "",
        status: "",
        depends: [],
        acceptance: [],
        statusLineNo: -1,
        raw: "",
      };
      return;
    }
    if (!current) return;

    const bullet = BULLET_RE.exec(line);
    if (bullet && collecting === "acceptance") {
      current.acceptance.push((bullet[1] ?? "").trim());
      return;
    }

    const field = FIELD_RE.exec(line);
    if (field) {
      const key = (field[1] ?? "").toLowerCase();
      const value = (field[2] ?? "").trim();
      switch (key) {
        case "id":
          if (!current.id) current.id = value;
          collecting = null;
          return;
        case "status":
          if (current.statusLineNo === -1) {
            current.status = value;
            current.statusLineNo = i;
          }
          collecting = null;
          return;
        case "depends":
          if (current.depends.length === 0 && value && !/^(none|-)$/i.test(value)) {
            current.depends = value
              .split(/[,\s]+/)
              .map((d) => d.trim())
              .filter(Boolean);
          }
          collecting = null;
          return;
        case "test":
          if (!current.test && value) current.test = value;
          collecting = null;
          return;
        case "acceptance":
          collecting = "acceptance";
          return;
        case "notes":
          collecting = "notes";
          current.notes = value === "|" ? "" : value;
          return;
        default:
          collecting = null;
          return;
      }
    }

    if (collecting === "notes" && line.trim()) {
      current.notes = ((current.notes ?? "") + "\n" + line.trim()).trim();
    }
  });
  close(lines.length);

  return features;
}

export function readSpec(file: string): Feature[] {
  return parseSpec(readFileSync(file, "utf8"));
}

/**
 * Structural problems, phrased so they can be handed straight back to the
 * model. Small local models drop required fields constantly; the validate →
 * feed-errors-back loop is what turns that into a usable spec.
 */
export function validateSpec(text: string): string[] {
  const features = parseSpec(text);
  const errors: string[] = [];
  if (features.length === 0) {
    return ['No features found (expected blocks starting with "## feature: <name>").'];
  }
  const seenIds = new Set<string>();
  for (const f of features) {
    const label = `Feature #${f.index}${f.name ? ` (${f.name})` : ""}`;
    if (!f.name) errors.push(`Feature #${f.index} has no name.`);
    if (!f.status) errors.push(`${label}: missing "status:".`);
    else if (!(FEATURE_STATUSES as readonly string[]).includes(f.status)) {
      errors.push(
        `${label}: invalid status "${f.status}" (expected one of ${FEATURE_STATUSES.join(", ")}).`,
      );
    }
    if (!f.id) errors.push(`${label}: missing "id:".`);
    else if (seenIds.has(f.id)) errors.push(`${label}: duplicate id "${f.id}".`);
    else seenIds.add(f.id);
    if (f.acceptance.length === 0) errors.push(`${label}: missing the "acceptance:" list.`);
  }
  // A dependency on a feature defined later cannot ever be satisfied in order.
  const indexById = new Map(features.map((f) => [f.id, f.index]));
  for (const f of features) {
    for (const dep of f.depends) {
      const depIndex = indexById.get(dep);
      if (depIndex === undefined) {
        errors.push(`Feature #${f.index} (${f.name}): depends on unknown id "${dep}".`);
      } else if (depIndex >= f.index) {
        errors.push(
          `Feature #${f.index} (${f.name}): depends on "${dep}", which is defined later. Order features so dependencies come first.`,
        );
      }
    }
  }
  return errors;
}

const isDone = (s: string) => s === "COMPLETED" || s === "UNVERIFIED";

/** First PENDING feature whose dependencies are all satisfied. */
export function nextPending(features: Feature[]): Feature | undefined {
  const byId = new Map(features.map((f) => [f.id, f]));
  return features.find((f) => {
    if (f.status !== "PENDING") return false;
    return f.depends.every((dep) => {
      const d = byId.get(dep);
      return d === undefined || isDone(d.status);
    });
  });
}

/** PENDING features exist, but every one of them is blocked by dependencies. */
export function hasBlockedPending(features: Feature[]): boolean {
  return features.some((f) => f.status === "PENDING") && nextPending(features) === undefined;
}

/**
 * Rewrite exactly one `status:` line, then re-read to confirm.
 *
 * If this silently fails the main loop reprocesses the same feature forever, so
 * the write is verified and the feature count is checked for good measure.
 */
export function setStatus(file: string, index: number, status: FeatureStatus): void {
  const text = readFileSync(file, "utf8");
  const before = parseSpec(text);
  const target = before.find((f) => f.index === index);
  if (!target) throw new Error(`Feature #${index} not found in ${file}`);
  if (target.statusLineNo < 0) throw new Error(`Feature #${index} has no "status:" line`);

  const lines = text.split("\n");
  const original = lines[target.statusLineNo] ?? "";
  const indent = /^(\s*)/.exec(original)?.[1] ?? "";
  lines[target.statusLineNo] = `${indent}status: ${status}`;
  const updated = lines.join("\n");

  const after = parseSpec(updated);
  if (after.length !== before.length) {
    throw new Error(`Refusing to write ${file}: feature count changed`);
  }
  writeFileSync(file, updated);

  const verify = readSpec(file).find((f) => f.index === index);
  if (verify?.status !== status) {
    throw new Error(`Failed to persist status ${status} for feature #${index}`);
  }
}

/** Move every feature in `from` back to PENDING. Returns how many moved. */
export function resetFrom(file: string, from: string): number {
  let count = 0;
  for (;;) {
    const features = readSpec(file);
    const hit = features.find((f) => f.status === from);
    if (!hit) break;
    setStatus(file, hit.index, "PENDING");
    count += 1;
  }
  return count;
}

/** Unstick features left IN_PROGRESS by a run that died mid-flight. */
export function resetStale(file: string, onReset?: (f: Feature) => void): number {
  let count = 0;
  for (;;) {
    const features = readSpec(file);
    const hit = features.find((f) => f.status === "IN_PROGRESS");
    if (!hit) break;
    onReset?.(hit);
    setStatus(file, hit.index, "PENDING");
    count += 1;
  }
  return count;
}

export interface SpecSummary {
  total: number;
  completed: number;
  unverified: number;
  failed: number;
  pending: number;
  inProgress: number;
  blocked: number;
}

export function summarize(features: Feature[]): SpecSummary {
  const count = (s: string) => features.filter((f) => f.status === s).length;
  return {
    total: features.length,
    completed: count("COMPLETED"),
    unverified: count("UNVERIFIED"),
    failed: count("FAILED"),
    pending: count("PENDING"),
    inProgress: count("IN_PROGRESS"),
    blocked: count("BLOCKED"),
  };
}

export function statusMark(status: string): string {
  switch (status) {
    case "COMPLETED":
      return "✔";
    case "FAILED":
      return "✖";
    case "UNVERIFIED":
      return "~";
    case "IN_PROGRESS":
      return "»";
    case "BLOCKED":
      return "⊘";
    default:
      return "·";
  }
}
