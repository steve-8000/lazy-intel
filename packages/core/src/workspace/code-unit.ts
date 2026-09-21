import { createHash } from "node:crypto";

/** The parser inputs that determine whether two CodeUnit parses are comparable. */
export interface ParserProfile {
  /** Grammar identifiers and versions, in deterministic order. */
  readonly grammarSet: readonly string[];
  /** Extraction implementation/schema version. */
  readonly extractionVersion: string;
  /** File-language mapping, represented as sorted `extension=language` entries. */
  readonly languageMapping: Readonly<Record<string, string>>;
}

export interface CodeUnit {
  readonly fileId: string;
  readonly relativePath: string;
  readonly contentHash: string;
  readonly content: string;
  readonly language: string;
  readonly parserProfile: ParserProfile;
  readonly parserProfileDigest: string;
}

function canonicalProfile(profile: ParserProfile): string {
  const languageMapping = Object.keys(profile.languageMapping)
    .sort()
    .map((extension) => [extension, profile.languageMapping[extension]]) as [string, string][];
  return JSON.stringify({
    grammarSet: [...profile.grammarSet].sort(),
    extractionVersion: profile.extractionVersion,
    languageMapping,
  });
}

export function parserProfileDigest(profile: ParserProfile): string {
  return createHash("sha256").update(canonicalProfile(profile)).digest("hex");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

export function createCodeUnit(input: {
  readonly fileId: string;
  readonly relativePath: string;
  readonly content: string;
  readonly language: string;
  readonly parserProfile: ParserProfile;
  readonly contentHash?: string;
}): CodeUnit {
  return {
    fileId: input.fileId,
    relativePath: input.relativePath,
    contentHash: input.contentHash ?? contentHash(input.content),
    content: input.content,
    language: input.language,
    parserProfile: input.parserProfile,
    parserProfileDigest: parserProfileDigest(input.parserProfile),
  };
}
