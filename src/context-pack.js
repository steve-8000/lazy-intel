import { normalizationOf, sortEvidence } from "./evidence.js";

export const WIRE_CAP_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const byteLength = (value) => encoder.encode(value).byteLength;

function operationOf(input) {
  return input?.operation ?? input?.requestedOperation ?? input?.request?.operation ?? "context";
}

function locatorLabel(locator) {
  if (!locator) return "unknown location";
  const range = locator.range;
  const lines = range ? `:${range.startLine + 1}-${range.endLineExclusive}` : "";
  return `${locator.relativePath}${lines}`;
}

function sourceDescriptor(item) {
  return {
    id: item.id,
    locator: item.locator,
    method: item.method,
    textKind: item.textKind ?? "source",
    sourceCheck: item.sourceCheck?.status ?? "unchecked",
    ...(item.anchor ? { anchor: item.anchor } : {}),
    ...(item.projectionView ? { projection: item.projectionView.projection, viewId: item.projectionView.viewId } : {}),
    ...(item.semanticObservation ? { semanticObservation: item.semanticObservation } : {}),
    ...(item.coverage ? { coverage: item.coverage } : {}),
    ...(item.relatedAnchors ? { relatedAnchors: item.relatedAnchors } : {}),
    provenance: item.provenance ?? [],
  };
}

function opaqueDescriptor(item) {
  return {
    id: item.id,
    method: "opaque",
    sourceCheck: "unchecked",
    provenance: [item.provenance],
  };
}

function envelopeFacts(envelopes) {
  const errors = [];
  let truncated = false;
  let returned = 0;
  let total = 0;
  const unique = (values) => [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  const views = unique(envelopes.flatMap((env) => env.views ?? []));
  const semanticObservations = unique(envelopes.flatMap((env) => env.semanticObservations ?? []));
  const issues = unique(envelopes.flatMap((env) => env.issues ?? []));
  let knownTotal = (envelopes ?? []).length > 0;
  for (const env of envelopes ?? []) {
    // The code is what an agent branches on (INDEX_BUILDING -> fall back now), so it leads.
    if (env?.error?.message) errors.push(`${env.backend ?? "backend"}${env.error.code ? ` ${env.error.code}` : ""}: ${env.error.message}`);
    if (env?.outcome === "error" || env?.outcome === "unavailable") {
      if (!env?.error?.message) errors.push(`${env.backend ?? "backend"}: ${env.outcome}`);
    }
    truncated ||= Boolean(env?.truncated);
    if (Number.isFinite(env?.returned)) returned += env.returned;
    if (Number.isFinite(env?.total)) total += env.total;
    else knownTotal = false;
  }
  return { errors, truncated, returned, total: knownTotal ? total : null, views, semanticObservations, issues };
}

function candidateBlock(item) {
  const heading = "### " + item.kind + " [" + item.id + "]\nLocation: " + locatorLabel(item.locator) + "\nText: " + (item.textKind ?? "source") + "\nSource check: " + (item.sourceCheck?.status ?? "unchecked");
  return `${heading}\n\n${item.text}`;
}

/** Location-only form of an item whose body alone would exceed the response budget. */
function compactBlock(item, maxChars) {
  const heading = "### " + item.kind + " [" + item.id + "]\nLocation: " + locatorLabel(item.locator) + "\nSource check: " + (item.sourceCheck?.status ?? "unchecked");
  return `${heading}\nBody omitted: ${String(item.text ?? "").length} characters do not fit maxChars=${maxChars}; read this range directly.`;
}

function opaqueBlock(item) {
  const backend = item.provenance?.backend ?? "unknown backend";
  return `### OPAQUE BACKEND BLOCK [${item.id}] (${backend})\nReason: ${item.reason}\n\n${item.text}`;
}

function safeMetadata(value) {
  return JSON.stringify(value);
}

function compactFallback(status, stopReason, isError) {
  return `Status: ${status}\nStop reason: ${stopReason}${isError ? "\nError: required obligation was not met" : ""}`;
}

/** Render typed and opaque evidence without cutting source blocks or JSON metadata. */
export function buildContextPack({
  input,
  envelopes = [],
  items = [],
  opaque = [],
  status = "ok",
  fulfillment = { requiredMet: true, unmet: [] },
  stopReason = "plan_complete",
  maxChars = Number.POSITIVE_INFINITY,
} = {}) {
  const operation = operationOf(input);
  const typed = sortEvidence(items, { operation });
  const raw = [...opaque];
  const facts = envelopeFacts(envelopes);
  const truncated = facts.truncated;
  const isError = status === "error" || fulfillment.requiredMet === false;
  // Downgraded to partial when evidence exists but some of it does not fit the budget.
  let packStatus = status;
  const totalAvailable = typed.length + raw.length;
  const totalKnown = facts.total !== null;
  const effectiveMax = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : Number.POSITIVE_INFINITY;
  const allCandidates = [
    ...typed.map((item) => ({ item, block: candidateBlock(item), compact: compactBlock(item, effectiveMax), descriptor: sourceDescriptor(item), typed: true })),
    ...raw.map((item) => ({ item, block: opaqueBlock(item), compact: null, descriptor: opaqueDescriptor(item), typed: false })),
  ];

  const mandatory = (selectedCount, omitted) => {
    const omittedLabel = omitted === null ? "unknown" : String(omitted);
    const lines = [
      `Status: ${packStatus}`,
      `Limits: maxChars=${Number.isFinite(maxChars) ? effectiveMax : "unbounded"}; wireCapBytes=${WIRE_CAP_BYTES}`,
      `Stop reason: ${stopReason}`,
    ];
    if (facts.errors.length) lines.push(`Errors: ${facts.errors.join("; ")}`);
    if (fulfillment.unmet?.length) lines.push(`Unmet obligations: ${fulfillment.unmet.join(", ")}`);
    if (truncated) lines.push("Backend output was truncated; coverage is incomplete.");
    lines.push(`Omitted items: ${omittedLabel}`);
    if (selectedCount === 0 && totalAvailable === 0) lines.push("No evidence items were returned.");
    if (selectedCount < totalAvailable) lines.push(`${totalAvailable - selectedCount} of ${totalAvailable} evidence items did not fit maxChars=${effectiveMax}; raise maxChars to see them.`);
    return lines.join("\n");
  };

  function omissionCount(selected) {
    if (!selected.length && totalAvailable === 0) return 0;
    if (totalKnown) return Math.max(0, facts.total - selected.length);
    return selected.length < totalAvailable ? null : (truncated ? null : 0);
  }

  function render(selected) {
    const omitted = omissionCount(selected);
    const sections = [mandatory(selected.length, omitted)];
    const definitions = selected.filter(({ item }) => ["definition", "implementation"].includes(item.kind));
    const relations = selected.filter(({ item }) => ["reference", "relation", "impact", "diagnostic"].includes(item.kind));
    const retrieval = selected.filter(({ item }) => item.kind === "retrieval");
    const opaqueBlocks = selected.filter(({ typed }) => !typed);
    for (const [title, group] of [["Primary subject / definitions", definitions], ["Requested references / relations", relations], ["Related retrieval", retrieval], ["Opaque backend blocks", opaqueBlocks]]) {
      if (group.length) {
        sections.push(`\n## ${title}\n\n${group.map(({ block }) => block).join("\n\n")}`);
      }
    }
    const metadata = {
      status: packStatus,
      fulfillment: { requiredMet: Boolean(fulfillment.requiredMet), unmet: [...(fulfillment.unmet ?? [])] },
      stopReason,
      coverage: facts.truncated || omitted !== 0 || envelopes.some((env) => env.coverage === "bounded")
        ? "bounded" : envelopes.length > 0 && envelopes.every((env) => env.coverage === "backend_complete")
          ? "backend_complete" : "unknown",
      omittedItems: omitted,
      truncated: Boolean(truncated || omitted !== 0),
      evidence: selected.map(({ descriptor }) => descriptor),
      views: facts.views,
      semanticObservations: facts.semanticObservations,
      issues: facts.issues,
    };
    return { text: sections.join("\n"), metaText: safeMetadata(metadata), omitted, metadata };
  }

  const fits = (rendered) => rendered.text.length + rendered.metaText.length <= effectiveMax &&
    byteLength(rendered.text) + byteLength(rendered.metaText) <= WIRE_CAP_BYTES;

  const selected = [];
  // Mandatory status/error material is accounted for before optional evidence selection.
  // An item whose body does not fit is still worth its location: without it an agent
  // reads "ok, no evidence" as "nothing relevant exists".
  for (const candidate of allCandidates) {
    if (fits(render([...selected, candidate]))) { selected.push(candidate); continue; }
    if (!candidate.compact) continue;
    const located = { ...candidate, block: candidate.compact, descriptor: { ...candidate.descriptor, bodyOmitted: true } };
    if (fits(render([...selected, located]))) selected.push(located);
  }
  // A bounded answer that shows at least one whole item is still ok — later hits appear as
  // locations and truncated/omittedItems say the rest. One that shows no body at all is not.
  if (packStatus === "ok" && totalAvailable > 0 && selected.every(({ descriptor }) => descriptor.bodyOmitted)) {
    packStatus = "partial";
    while (selected.length && !fits(render(selected))) selected.pop();
  }

  let rendered = render(selected);
  if (!fits(rendered)) {
    // No source item is split. If even mandatory prose is too large, use a compact mandatory
    // representation and retain valid JSON metadata rather than slicing either output.
    const omitted = omissionCount([]);
    let metadata = safeMetadata({ status: packStatus, stopReason, omittedItems: omitted, truncated: true, evidence: [], metadataOmitted: true });
    let text = mandatory(0, omitted);
    if (text.length + metadata.length > effectiveMax || byteLength(text) + byteLength(metadata) > WIRE_CAP_BYTES) {
      text = compactFallback(packStatus, stopReason, isError);
    }
    if (text.length + metadata.length > effectiveMax || byteLength(text) + byteLength(metadata) > WIRE_CAP_BYTES) {
      metadata = "0";
      text = effectiveMax >= 1 ? "" : "";
    }
    if (text.length + metadata.length > effectiveMax || byteLength(text) + byteLength(metadata) > WIRE_CAP_BYTES) {
      text = "0";
    }
    selected.length = 0;
    rendered = { text, metaText: metadata, omitted, metadata: { metadataOmitted: true } };
  }

  const selectedIds = selected.map(({ item }) => item.id);
  const descriptors = selected.map(({ descriptor }) => descriptor);
  const normal = normalizationOf(typed, raw);
  return {
    text: rendered.text,
    metaText: rendered.metaText,
    status: packStatus,
    isError,
    fulfillment: { requiredMet: Boolean(fulfillment.requiredMet), unmet: [...(fulfillment.unmet ?? [])] },
    stopReason,
    selected: selectedIds,
    omittedItems: rendered.omitted,
    truncated: Boolean(truncated || rendered.omitted !== 0),
    normalization: normal,
    evidence: descriptors,
    coverage: rendered.metadata.coverage ?? "bounded",
    views: rendered.metadata.views ?? [],
    semanticObservations: rendered.metadata.semanticObservations ?? [],
    issues: rendered.metadata.issues ?? [],
    metadataOmitted: rendered.metadata.metadataOmitted ?? false,
  };
}
