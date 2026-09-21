import { createHash } from "node:crypto";
import type { CanonicalAnchor, Evidence, NativeAlias, SourceSpan } from "../contracts.js";

export interface CanonicalAnchorInput {
  readonly workspaceId: string;
  readonly fileId: string;
  /** Carried on the anchor because a live read has no manifest to resolve fileId. */
  readonly relativePath: string;
  readonly contentHash: string;
  readonly span: SourceSpan;
  readonly kind: string;
  readonly stableEntityId?: string;
}

function keyPart(value: unknown): string {
  return JSON.stringify(value);
}

export function canonicalAnchorKey(anchor: Pick<CanonicalAnchor, "workspaceId" | "fileId" | "contentHash" | "span" | "kind">): string {
  return [anchor.workspaceId, anchor.fileId, anchor.contentHash, anchor.span.coordinateSystem, anchor.span.startByte, anchor.span.endByte, anchor.kind].map(keyPart).join(":");
}

export function createCanonicalAnchor(input: CanonicalAnchorInput): CanonicalAnchor {
  const key = canonicalAnchorKey(input);
  const occurrenceId = createHash("sha256").update(key).digest("hex");
  return input.stableEntityId === undefined ? { ...input, occurrenceId } : { ...input, occurrenceId, stableEntityId: input.stableEntityId };
}

export function evidenceIdentity(evidence: Pick<Evidence, "anchor">): string | null {
  return evidence.anchor ? canonicalAnchorKey(evidence.anchor) : null;
}

export function evidenceAnchorsAgree(left: Pick<Evidence, "anchor">, right: Pick<Evidence, "anchor">): boolean {
  if (!left.anchor || !right.anchor) return false;
  return canonicalAnchorKey(left.anchor) === canonicalAnchorKey(right.anchor);
}

export function addNativeAlias(evidence: Evidence, alias: NativeAlias): Evidence {
  if (evidence.aliases.some((existing) => existing.engine === alias.engine && existing.engineRevision === alias.engineRevision && existing.nativeId === alias.nativeId)) return evidence;
  return { ...evidence, aliases: [...evidence.aliases, alias] };
}

export function mergeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  const merged: Evidence[] = [];
  const byAnchor = new Map<string, number>();
  for (const item of items) {
    const identity = evidenceIdentity(item);
    const existingIndex = identity === null ? undefined : byAnchor.get(identity);
    if (existingIndex === undefined) {
      if (identity !== null) byAnchor.set(identity, merged.length);
      merged.push(item);
      continue;
    }
    const existing = merged[existingIndex] as Evidence;
    const aliases = [...existing.aliases];
    for (const alias of item.aliases) {
      if (!aliases.some((candidate) => candidate.engine === alias.engine && candidate.engineRevision === alias.engineRevision && candidate.nativeId === alias.nativeId)) aliases.push(alias);
    }
    merged[existingIndex] = { ...existing, aliases };
  }
  return merged;
}
