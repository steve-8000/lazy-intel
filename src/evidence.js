import {
  EVIDENCE_KINDS,
  EVIDENCE_METHODS,
  OPAQUE_REASONS,
  SOURCE_CHECK_STATUSES,
} from "./contracts.js";

const COLUMN_ENCODINGS = new Set(["utf16", "utf8_bytes", "unicode_codepoints"]);
const OBSERVATION_CONSISTENCY = new Set([
  "observed_stable", "concurrent_change_observed", "unverified",
]);

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = copy(child);
    return result;
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function validateLocator(locator, name = "locator") {
  if (!locator || typeof locator !== "object") throw new TypeError(`${name} is required`);
  requiredString(locator.rootKey, `${name}.rootKey`);
  requiredString(locator.relativePath, `${name}.relativePath`);
  if (locator.range !== undefined) {
    const range = locator.range;
    if (!Number.isInteger(range.startLine) || range.startLine < 0 ||
        !Number.isInteger(range.endLineExclusive) || range.endLineExclusive < range.startLine) {
      throw new TypeError(`${name}.range must use a non-negative, end-exclusive line range`);
    }
    if (range.columns !== undefined) {
      const columns = range.columns;
      if (!Number.isInteger(columns.start) || !Number.isInteger(columns.end) ||
          columns.start < 0 || columns.end < columns.start || !COLUMN_ENCODINGS.has(columns.encoding)) {
        throw new TypeError(`${name}.range.columns is invalid`);
      }
    }
  }
  return copy(locator);
}

function validateObservation(observation) {
  const value = observation ?? { before: null, after: null, consistency: "unverified" };
  if (value.before === undefined || value.after === undefined ||
      !OBSERVATION_CONSISTENCY.has(value.consistency)) throw new TypeError("observation is invalid");
  return copy(value);
}

function validateSourceCheck(sourceCheck) {
  const value = sourceCheck ?? { status: "unchecked", reason: "not checked" };
  if (!SOURCE_CHECK_STATUSES.includes(value.status)) throw new TypeError("sourceCheck.status is invalid");
  if (value.status === "matched" && typeof value.sha256 !== "string") throw new TypeError("matched sourceCheck needs sha256");
  if (value.status !== "matched" && typeof value.reason !== "string") throw new TypeError("unmatched sourceCheck needs reason");
  return copy(value);
}

function validateProvenance(provenance) {
  if (!Array.isArray(provenance)) throw new TypeError("provenance must be an array");
  return provenance.map((entry) => {
    if (!entry || typeof entry !== "object") throw new TypeError("provenance entry is invalid");
    for (const key of ["backend", "operation", "backendVersion", "adapterVersion", "executionId"]) {
      requiredString(entry[key], `provenance.${key}`);
    }
    return copy(entry);
  });
}

export function makeEvidence(spec) {
  if (!spec || typeof spec !== "object") throw new TypeError("evidence spec is required");
  if (!EVIDENCE_KINDS.includes(spec.kind)) throw new TypeError(`unsupported evidence kind: ${spec.kind}`);
  if (!EVIDENCE_METHODS.includes(spec.method)) throw new TypeError(`unsupported evidence method: ${spec.method}`);
  requiredString(spec.id, "id");
  requiredString(spec.text, "text");
  if (spec.textKind !== undefined && spec.textKind !== "source" && spec.textKind !== "description") throw new TypeError("evidence textKind is invalid");
  const item = {
    id: spec.id,
    kind: spec.kind,
    method: spec.method,
    locator: validateLocator(spec.locator),
    ...(spec.subject === undefined ? {} : { subject: copy(spec.subject) }),
    ...(spec.relation === undefined ? {} : {
      relation: {
        ...copy(spec.relation),
        target: validateLocator(spec.relation.target, "relation.target"),
      },
    }),
    text: spec.text,
    textKind: spec.textKind ?? "source",
    sourceCheck: validateSourceCheck(spec.sourceCheck),
    observation: validateObservation(spec.observation),
    ...(spec.anchor === undefined ? {} : { anchor: copy(spec.anchor) }),
    ...(spec.projectionView === undefined ? {} : { projectionView: copy(spec.projectionView) }),
    ...(spec.semanticObservation === undefined ? {} : { semanticObservation: copy(spec.semanticObservation) }),
    ...(spec.coverage === undefined ? {} : { coverage: copy(spec.coverage) }),
    ...(spec.relatedAnchors === undefined ? {} : { relatedAnchors: copy(spec.relatedAnchors) }),
    provenance: validateProvenance(spec.provenance ?? []),
  };
  return freeze(item);
}

export function makeOpaque(spec) {
  if (!spec || typeof spec !== "object") throw new TypeError("opaque spec is required");
  requiredString(spec.id, "id");
  requiredString(spec.text, "text");
  if (!OPAQUE_REASONS.includes(spec.reason)) throw new TypeError(`unsupported opaque reason: ${spec.reason}`);
  const provenance = validateProvenance([spec.provenance])[0];
  return freeze({ id: spec.id, method: "opaque", text: spec.text, reason: spec.reason, provenance });
}

function json(value) {
  return JSON.stringify(value, (_, child) => child === undefined ? null : child);
}

function locatorKey(locator) {
  if (!locator?.rootKey || !locator?.relativePath) return null;
  const range = locator.range;
  return json({
    root: locator.rootKey,
    path: locator.relativePath,
    range: range ? {
      startLine: range.startLine,
      endLineExclusive: range.endLineExclusive,
      columns: range.columns ?? null,
    } : null,
  });
}

function identityPart(item) {
  if (item.subject?.signature) return ["signature", item.subject.signature];
  if (item.subject?.backendId && item.subject?.backendNamespace) {
    return ["backend", item.subject.backendNamespace, item.subject.backendId];
  }
  if (item.relation) {
    const target = locatorKey(item.relation.target);
    if (!target) return null;
    const targetIdentity = item.relation.targetIdentity?.signature
      ? ["signature", item.relation.targetIdentity.signature]
      : item.relation.targetIdentity?.backendId && item.relation.targetIdentity?.backendNamespace
        ? ["backend", item.relation.targetIdentity.backendNamespace, item.relation.targetIdentity.backendId]
        : item.relation.backendRelationName
          ? ["relation", item.relation.backendRelationName]
          : ["locator", target];
    return ["target", item.relation.kind, target, targetIdentity];
  }
  return null;
}

function fingerprint(item) {
  if (item.anchor?.contentHash && item.anchor.contentHash !== "unknown") return `sha256:${item.anchor.contentHash}`;
  const source = item.sourceCheck;
  if (source?.status === "matched" && source.sha256) return `sha256:${source.sha256}`;
  const observation = item.observation;
  if (observation?.consistency === "observed_stable" && observation.before && observation.after) {
    const before = observation.before;
    const after = observation.after;
    if (before.processEpoch !== undefined && before.generation !== undefined &&
        after.processEpoch === before.processEpoch && after.generation === before.generation) {
      return `generation:${before.processEpoch}:${before.generation}`;
    }
  }
  return null;
}

export function identityKey(item) {
  if (!item || item.method === "opaque") return null;
  const location = locatorKey(item.locator);
  const identity = identityPart(item);
  if (!location || !identity || !EVIDENCE_KINDS.includes(item.kind)) return null;
  const source = fingerprint(item);
  if (!source) return null;
  return json({ location, kind: item.kind, textKind: item.textKind ?? "source", identity, source });
}

function provenanceKey(entry) {
  return json(entry);
}

export function dedupe(items) {
  const result = [];
  const indexes = new Map();
  for (const item of items ?? []) {
    const key = identityKey(item);
    if (!key || !indexes.has(key)) {
      if (key) indexes.set(key, result.length);
      result.push(item);
      continue;
    }
    const index = indexes.get(key);
    const current = result[index];
    const provenance = [...current.provenance];
    const seen = new Set(provenance.map(provenanceKey));
    for (const entry of item.provenance ?? []) {
      if (!seen.has(provenanceKey(entry))) {
        provenance.push(entry);
        seen.add(provenanceKey(entry));
      }
    }
    result[index] = freeze({ ...current, provenance: freeze(provenance.map(copy)) });
  }
  return result;
}

const ROLE_ORDER = {
  definition: 0,
  implementation: 1,
  reference: 2,
  relation: 3,
  impact: 4,
  diagnostic: 5,
  retrieval: 6,
};
const RELEVANCE = {
  definition: new Set(["symbol", "context", "auto", "implementations"]),
  implementation: new Set(["implementations", "symbol", "context", "auto"]),
  reference: new Set(["references", "impact", "context", "auto"]),
  relation: new Set(["impact", "architecture", "context", "auto"]),
  impact: new Set(["impact", "context", "auto"]),
  diagnostic: new Set(["diagnostics", "context", "auto"]),
  retrieval: new Set(["search", "context", "auto"]),
};
const CHECK_ORDER = { matched: 0, unchecked: 1, mismatch: 2 };

function tieKey(item) {
  return json({
    path: locatorKey(item.locator),
    kind: item.kind,
    method: item.method,
    range: item.locator?.range ?? null,
    identity: identityPart(item),
    id: item.id,
  });
}

export function sortEvidence(items, { operation } = {}) {
  return [...(items ?? [])].sort((a, b) => {
    const aRelevant = RELEVANCE[a.kind]?.has(operation) ? 0 : 1;
    const bRelevant = RELEVANCE[b.kind]?.has(operation) ? 0 : 1;
    if (aRelevant !== bRelevant) return aRelevant - bRelevant;
    const role = (ROLE_ORDER[a.kind] ?? 99) - (ROLE_ORDER[b.kind] ?? 99);
    if (role) return role;
    const check = (CHECK_ORDER[a.sourceCheck?.status] ?? 99) - (CHECK_ORDER[b.sourceCheck?.status] ?? 99);
    if (check) return check;
    return tieKey(a).localeCompare(tieKey(b));
  });
}

export function normalizationOf(items = [], opaque = []) {
  const typed = items.length > 0;
  const raw = opaque.length > 0;
  if (typed && raw) return "mixed";
  if (typed) return "typed";
  if (raw) return "opaque";
  return "none";
}
