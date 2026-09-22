#!/usr/bin/env node
import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createSemanticAdapter } from "../packages/core/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const WORKSPACE_ID = "semantic-live-proof";
const context = {
  requestId: "semantic-live-proof",
  workspaceId: WORKSPACE_ID,
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 120_000,
  maxEvidence: 100,
  maxOutputChars: 1_000_000,
  maxWireBytes: 4_000_000,
};
const log = (line, stream) => process.stderr.write(`[semantic ${stream}] ${line}\n`);

async function createSilentPushOnlyServer(directory) {
  const serverPath = join(directory, "silent-push-only-lsp.js");
  const source = [
    "#!/usr/bin/env node",
    "let buffer = Buffer.alloc(0);",
    "const send = (message) => { const body = JSON.stringify(message); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body); };",
    "const handle = (message) => {",
    "  if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1, completionProvider: {}, definitionProvider: true } } }); return; }",
    "  if (message.method === 'initialized') { setImmediate(() => send({ jsonrpc: '2.0', method: 'experimental/serverStatus', params: { quiescent: true } })); return; }",
    "  if (message.method === 'shutdown') { send({ jsonrpc: '2.0', id: message.id, result: null }); return; }",
    "  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });",
    "};",
    "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); for (;;) { const split = buffer.indexOf('\\r\\n\\r\\n'); if (split < 0) break; const header = buffer.subarray(0, split).toString('ascii'); const match = header.match(/Content-Length: (\\d+)/i); if (!match) process.exit(2); const length = Number(match[1]); const start = split + 4; if (buffer.length < start + length) break; const body = buffer.subarray(start, start + length).toString('utf8'); buffer = buffer.subarray(start + length); handle(JSON.parse(body)); } });"
  ].join("\n");
  await writeFile(serverPath, source, "utf8");
  await execFileAsync("chmod", ["+x", serverPath]);
  return serverPath;
}
async function createPullDiagnosticsServer(directory) {
  const serverPath = join(directory, "pull-diagnostics-lsp.js");
  const source = [
    "#!/usr/bin/env node",
    "let buffer = Buffer.alloc(0); let requests = 0;",
    "const send = (message) => { const body = JSON.stringify(message); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body); };",
    "const handle = (message) => {",
    "  if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1, completionProvider: {}, definitionProvider: true, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } } }); return; }",
    "  if (message.method === 'initialized') { setImmediate(() => send({ jsonrpc: '2.0', method: 'experimental/serverStatus', params: { quiescent: true } })); return; }",
    "  if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didClose') return;",
    "  if (message.method === 'textDocument/diagnostic') { requests += 1; const items = requests === 1 ? [{ severity: 1, message: 'pull error', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : []; send({ jsonrpc: '2.0', id: message.id, result: { kind: 'full', items } }); return; }",
    "  if (message.method === 'shutdown') { send({ jsonrpc: '2.0', id: message.id, result: null }); return; }",
    "  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });",
    "};",
    "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); for (;;) { const split = buffer.indexOf('\\r\\n\\r\\n'); if (split < 0) break; const header = buffer.subarray(0, split).toString('ascii'); const match = header.match(/Content-Length: (\\d+)/i); if (!match) process.exit(2); const length = Number(match[1]); const start = split + 4; if (buffer.length < start + length) break; const body = buffer.subarray(start, start + length).toString('utf8'); buffer = buffer.subarray(start + length); handle(JSON.parse(body)); } });"
  ].join("\n");
  await writeFile(serverPath, source, "utf8");
  await execFileAsync("chmod", ["+x", serverPath]);
  await execFileAsync(process.execPath, ["--check", serverPath]);
  return serverPath;
}
async function createDiagnosticsPushServer(directory) {
  const serverPath = join(directory, "diagnostics-push-lsp.js");
  const source = [
    "#!/usr/bin/env node",
    "let buffer = Buffer.alloc(0); let opens = 0;",
    "const send = (message) => { const body = JSON.stringify(message); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body); };",
    "const handle = (message) => {",
    "  if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1, completionProvider: {}, definitionProvider: true } } }); return; }",
    "  if (message.method === 'initialized') { setImmediate(() => send({ jsonrpc: '2.0', method: 'experimental/serverStatus', params: { quiescent: true } })); return; }",
    "  if (message.method === 'textDocument/didOpen') { opens += 1; const uri = message.params.textDocument.uri; const diagnostics = opens === 1 ? [{ severity: 1, message: 'controlled error', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : []; setImmediate(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } })); return; }",
    "  if (message.method === 'shutdown') { send({ jsonrpc: '2.0', id: message.id, result: null }); return; }",
    "  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });",
    "};",
    "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); for (;;) { const split = buffer.indexOf('\\r\\n\\r\\n'); if (split < 0) break; const header = buffer.subarray(0, split).toString('ascii'); const match = header.match(/Content-Length: (\\d+)/i); if (!match) process.exit(2); const length = Number(match[1]); const start = split + 4; if (buffer.length < start + length) break; const body = buffer.subarray(start, start + length).toString('utf8'); buffer = buffer.subarray(start + length); handle(JSON.parse(body)); } });"
  ].join("\n");
  await writeFile(serverPath, source, "utf8"); await execFileAsync("chmod", ["+x", serverPath]); await execFileAsync(process.execPath, ["--check", serverPath]); return serverPath;
}
function executable(candidate) { const canonical = realpathSync(candidate); accessSync(canonical, constants.X_OK); return canonical; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function serverProfileDigest(language, languageServerPath, upstreamCommit) { return sha256(Buffer.from(JSON.stringify({ engine: "serena", language, languageServerPath, upstreamCommit, protocol: "lazy-read-api-v1" }), "utf8")); }
function request(operation, subject = null, relativePath = null, extra = {}) { return { operation, subject, relativePath, includeBody: true, ...extra }; }
function anchorExcerpt(bytes, anchor) { return anchor ? bytes.subarray(anchor.span.startByte, anchor.span.endByte).toString("utf8") : null; }
function assert(condition, message) { if (!condition) throw new Error(message); }

async function publicSemanticProbe(workspace, tsls, tsBytes) {
  const probe = `
    const { codeIntel } = await import(${JSON.stringify(join(ROOT, "src/engine.js"))});
    const { closeUnified } = await import(${JSON.stringify(join(ROOT, "src/unified.js"))});
    const out = {};
    try {
      for (const operation of ["symbol", "references"]) {
        const result = await codeIntel({ operation, root: ${JSON.stringify(workspace)}, symbol: operation === "references" ? "parse[0]" : "parse", relativePath: "overloads.ts", includeBody: true, limit: 20, maxChars: 80000, timeoutMs: 120000, indexTimeoutMs: 240000 });
        out[operation] = { backends: result.meta.backends, evidence: result.meta.evidence, semanticObservations: result.meta.semanticObservations, issues: result.meta.issues };
      }
    } finally { await closeUnified(); }
    process.stdout.write("RESULT:" + JSON.stringify(out) + "\\n");
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: ROOT, timeout: 300000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_LSP: JSON.stringify({ typescript: tsls }), LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0" },
  });
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
  assert(line, `public codeIntel probe emitted no result: ${stdout}`);
  const out = JSON.parse(line.slice("RESULT:".length));
  for (const operation of ["symbol", "references"]) {
    const row = out[operation]?.backends?.find((entry) => entry.backend === "serena");
    assert(row?.outcome === "ok", `public ${operation} backend failed: ${JSON.stringify(out[operation])}`);
    assert((out[operation].evidence ?? []).length > 0, `public ${operation} returned no evidence`);
    for (const descriptor of out[operation].evidence) {
      assert(descriptor.sourceCheck === "matched", `public ${operation} sourceCheck was not matched: ${JSON.stringify(descriptor)}`);
      assert(descriptor.locator?.relativePath === "overloads.ts", `public ${operation} pointed at wrong path: ${JSON.stringify(descriptor)}`);
      if (descriptor.textKind === "source") {
        const span = descriptor.anchor?.span;
        assert(span && Number.isInteger(span.startByte) && Number.isInteger(span.endByte), `public ${operation} source claim has no byte span`);
        const captured = tsBytes.subarray(span.startByte, span.endByte).toString("utf8");
        assert(captured.includes("parse"), `public ${operation} source span did not capture the requested overload/reference: ${JSON.stringify({ captured, span })}`);
        if (descriptor.text !== undefined) assert(captured === descriptor.text, `public ${operation} source text differs from captured bytes: ${JSON.stringify({ captured, text: descriptor.text, span })}`);
      }
    }
  }
  return out;
}

async function main() {
  const tsls = executable(process.env.LAZY_INTEL_TS_LSP ?? "/opt/homebrew/bin/typescript-language-server");
  const pyright = executable(process.env.LAZY_INTEL_PYRIGHT_LSP ?? "/opt/homebrew/bin/pyright-langserver");
  const tsProfile = serverProfileDigest("typescript", tsls, "949a27ef1e5fda1a6e7b561e777bcece345c6ffd");
  const pyProfile = serverProfileDigest("python", pyright, "949a27ef1e5fda1a6e7b561e777bcece345c6ffd");
  const workspace = await mkdtemp(join(tmpdir(), "lazy-semantic-live-"));
  const tsText = [
    "export function parse(value: string): string;",
    "export function parse(value: number): number;",
    "export function parse(value: boolean): boolean;",
    "export function parse(value: string | number | boolean): string | number | boolean { return value; }",
    "export function use(): string { const marker = \"😀\"; return parse(marker); }",
    "",
  ].join("\r\n");
  const pyText = "def ok(value: str) -> str:\r\n    return value  # 😀\r\n";
  const pyErrorText = "def ok(value: str) -> str:\r\n    marker = \"😀\"; count: int = \"bad\"\r\n    return value\r\n";
  await writeFile(join(workspace, "overloads.ts"), tsText, "utf8");
  await writeFile(join(workspace, "clean.py"), pyText, "utf8");
  const tsBytes = Buffer.from(tsText, "utf8");
  const tsBufferBytes = Buffer.from(tsText.replace(/\r\n/g, "\n"), "utf8");
  const tsAdapter = createSemanticAdapter({ workspaceId: WORKSPACE_ID, sourceRoot: workspace, scopeDigest: sha256(Buffer.from(workspace)), language: "typescript", languageServerPath: tsls, trustedForLanguageTools: true, upstreamCommit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd", workerPath: join(ROOT, "workers/semantic/main.mjs"), supervisor: { onLog: log } });
  const pyAdapter = createSemanticAdapter({ workspaceId: WORKSPACE_ID, sourceRoot: workspace, scopeDigest: sha256(Buffer.from(workspace)), language: "python", languageServerPath: pyright, trustedForLanguageTools: true, upstreamCommit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd", workerPath: join(ROOT, "workers/semantic/main.mjs"), supervisor: { onLog: log } });
  const silentPushOnly = await createSilentPushOnlyServer(workspace);
  const silentProfile = serverProfileDigest("python", realpathSync(silentPushOnly), "949a27ef1e5fda1a6e7b561e777bcece345c6ffd");
  const silentAdapter = createSemanticAdapter({ workspaceId: WORKSPACE_ID, sourceRoot: workspace, scopeDigest: sha256(Buffer.from(workspace)), language: "python", languageServerPath: silentPushOnly, trustedForLanguageTools: true, upstreamCommit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd", workerPath: join(ROOT, "workers/semantic/main.mjs"), supervisor: { onLog: log } });
  const diagnosticsPush = await createDiagnosticsPushServer(workspace);
  const diagnosticsPushAdapter = createSemanticAdapter({ workspaceId: WORKSPACE_ID, sourceRoot: workspace, scopeDigest: sha256(Buffer.from(workspace)), language: "python", languageServerPath: diagnosticsPush, trustedForLanguageTools: true, upstreamCommit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd", workerPath: join(ROOT, "workers/semantic/main.mjs"), supervisor: { onLog: log } });
  const pullDiagnostics = await createPullDiagnosticsServer(workspace);
  const pullProfile = serverProfileDigest("python", realpathSync(pullDiagnostics), "949a27ef1e5fda1a6e7b561e777bcece345c6ffd");
  const pullAdapter = createSemanticAdapter({ workspaceId: WORKSPACE_ID, sourceRoot: workspace, scopeDigest: sha256(Buffer.from(workspace)), language: "python", languageServerPath: pullDiagnostics, trustedForLanguageTools: true, upstreamCommit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd", workerPath: join(ROOT, "workers/semantic/main.mjs"), supervisor: { onLog: log } });
  const cases = {};
  try {
    const symbols = await tsAdapter.read(request("symbol", { namePath: "parse", relativePath: "overloads.ts", anchor: null, nativeAlias: null }, "overloads.ts", { maxMatches: -1 }), context);
    const overloads = symbols.evidence.filter((entry) => entry.anchor?.relativePath === "overloads.ts");
    assert(symbols.outcome !== "error" && overloads.length >= 4, `SEM01 expected overload declarations plus implementation: ${JSON.stringify(symbols)}`);
    assert(new Set(overloads.map((entry) => entry.anchor.span.startByte)).size >= 4, "SEM01 symbols collapsed to one location");
    const expectedOverloads = [
      "export function parse(value: string): string;",
      "export function parse(value: number): number;",
      "export function parse(value: boolean): boolean;",
      "export function parse(value: string | number | boolean): string | number | boolean { return value; }",
    ];
    for (const expected of expectedOverloads) {
      const expectedBytes = Buffer.from(expected, "utf8");
      const expectedStart = tsBytes.indexOf(expectedBytes);
      const match = overloads.find((entry) => entry.anchor.span.startByte === expectedStart);
      assert(expectedStart >= 0 && match?.text === expected && match.anchor.span.endByte === expectedStart + expectedBytes.length, `SEM01 exact overload span/text mismatch: ${JSON.stringify({ expected, expectedStart, match })}`);
    }
    const ambiguous = await tsAdapter.read(request("symbol", { namePath: "parse", relativePath: null, anchor: null, nativeAlias: null }, null, { maxMatches: -1 }), context);
    cases["SEM-01"] = { status: "PASS", observations: { scoped: symbols, ambiguity_probe: ambiguous, overload_count: overloads.length } };

    const refs = await tsAdapter.read(request("references", { namePath: "parse[0]", relativePath: "overloads.ts", anchor: null, nativeAlias: null }, "overloads.ts"), context);
    assert(refs.outcome !== "error" && refs.evidence.length >= 1, `SEM02 expected references: ${JSON.stringify(refs)}`);
    const reference = refs.evidence.find((entry) => entry.kind === "reference");
    assert(reference?.anchor?.relativePath === "overloads.ts", "SEM02 reference anchor points at wrong file");
    assert(reference?.relatedAnchors?.some((entry) => entry.role === "containing-symbol"), "SEM02 missing containing-symbol anchor");
    const refExcerpt = anchorExcerpt(tsBytes, reference.anchor);
    assert(refExcerpt && refExcerpt.includes("parse"), `SEM02 exact reference anchor excerpt mismatch: ${JSON.stringify({ refExcerpt, anchor: reference.anchor })}`);
    cases["SEM-02"] = { status: "PASS", observations: { result: refs, exact_excerpt: refExcerpt } };

    const publicOut = await publicSemanticProbe(workspace, tsls, tsBytes);
    cases["SEM-01"].observations.public = publicOut.symbol;
    cases["SEM-02"].observations.public = publicOut.references;
    const publicObserved = publicOut.symbol.semanticObservations?.[0];
    assert(publicObserved?.sessionEpoch && publicObserved.serverProfileDigest === tsProfile && publicObserved.scope === "own-buffer" && Number.isInteger(publicObserved.documentVersion) && publicObserved.bufferHash === sha256(tsBufferBytes) && publicObserved.fileHash === sha256(tsBytes), `SEM03 public observation did not describe the owned LSP document/profile: ${JSON.stringify({ publicObserved, expectedProfile: tsProfile, expectedBufferHash: sha256(tsBufferBytes), expectedFileHash: sha256(tsBytes) })}`);

    const observed = symbols.semanticObservations?.[0];
    assert(observed?.sessionEpoch && observed.serverProfileDigest === tsProfile, `SEM03 missing live session observation/profile: ${JSON.stringify({ observed, expectedProfile: tsProfile })}`);
    assert(observed.scope === "own-buffer" && Number.isInteger(observed.documentVersion) && observed.bufferHash === sha256(tsBufferBytes), `SEM03 owned LSP buffer/version/hash was not explicit: ${JSON.stringify({ observed, expectedBufferHash: sha256(tsBufferBytes) })}`);
    assert(observed.fileHash === sha256(tsBytes), "SEM03 observation hash is not the fixture bytes");
    assert(observed.positionEncoding === "utf-16", `SEM03 expected UTF-16 TypeScript LSP encoding: ${JSON.stringify(observed)}`);
    cases["SEM-03"] = { status: "PASS", observations: { observation: observed, public_observation: publicObserved, scope_claim: "own-buffer; owned LSP version and UTF-8 hash observed", language_server: { path: tsls, sha256: sha256(await readFile(tsls)) } } };

    const useResult = await tsAdapter.read(request("symbol", { namePath: "use", relativePath: "overloads.ts", anchor: null, nativeAlias: null }, "overloads.ts"), context);
    const use = useResult.evidence.find((entry) => entry.anchor?.relativePath === "overloads.ts");
    assert(use?.anchor, "SEM04 could not locate use() anchor");
    const useExcerpt = anchorExcerpt(tsBytes, use.anchor);
    const useExpected = "export function use(): string { const marker = \"😀\"; return parse(marker); }";
    const useExpectedBytes = Buffer.from(useExpected, "utf8");
    const useStartByte = tsBytes.indexOf(useExpectedBytes);
    assert(useStartByte >= 0, "SEM04 fixture line missing from raw UTF-8 bytes");
    assert(use.anchor.span.startByte === useStartByte && use.anchor.span.endByte === useStartByte + useExpectedBytes.length, `SEM04 body span was not independently computed from fixture bytes: ${JSON.stringify({ anchor: use.anchor, useStartByte, expectedEndByte: useStartByte + useExpectedBytes.length })}`);
    assert(useExcerpt === useExpected, `SEM04 UTF-8 body anchor was not exact fixture line: ${JSON.stringify({ useExcerpt, useExpected, anchor: use.anchor })}`);
    assert(refExcerpt.includes("😀") && Buffer.from(refExcerpt, "utf8").includes(Buffer.from("😀")), "SEM04 reference context lost UTF-8 emoji bytes");
    assert(tsText.includes("😀") && tsBytes.includes(Buffer.from("😀")), "SEM04 fixture did not retain UTF-8 emoji bytes");
    cases["SEM-04"] = { status: "PASS", observations: { line_ending: "CRLF", position_encoding: observed.positionEncoding, fixture_sha256: sha256(tsBytes), exact_excerpt: useExcerpt, reference_excerpt: refExcerpt, emoji_utf8: Buffer.from("😀", "utf8").toString("hex") } };
    const controlledError = await diagnosticsPushAdapter.read(request("diagnostics", null, "clean.py"), context);
    const controlledEmpty = await diagnosticsPushAdapter.read(request("diagnostics", null, "clean.py"), context);
    assert(controlledError.evidence.length === 1 && controlledError.semanticObservations?.[0]?.diagnosticsStatus === "complete", "SEM08 controlled push error was not complete: " + JSON.stringify(controlledError));
    assert(controlledEmpty.outcome === "empty" && controlledEmpty.evidence.length === 0 && controlledEmpty.issues.length === 0 && controlledEmpty.semanticObservations?.[0]?.diagnosticsStatus === "complete", "SEM08 controlled empty push was not complete empty: " + JSON.stringify(controlledEmpty));
    const pullError = await pullAdapter.read(request("diagnostics", null, "clean.py"), context);
    const pullEmpty = await pullAdapter.read(request("diagnostics", null, "clean.py"), context);
    assert(pullError.evidence.length === 1 && pullError.evidence[0].text === "pull error" && pullError.semanticObservations?.[0]?.diagnosticsStatus === "complete", "SEM08 controlled pull error was not complete: " + JSON.stringify(pullError));
    assert(pullEmpty.outcome === "empty" && pullEmpty.evidence.length === 0 && pullEmpty.issues.length === 0 && pullEmpty.semanticObservations?.[0]?.diagnosticsStatus === "complete", "SEM08 valid pull empty reused stale diagnostics: " + JSON.stringify(pullEmpty));
    const clean = await pyAdapter.read(request("diagnostics", null, "clean.py"), context);
    assert(clean.outcome === "empty" && clean.evidence.length === 0 && clean.issues.length === 0, `SEM08 clean diagnostics must be completed empty: ${JSON.stringify(clean)}`);
    assert(clean.semanticObservations?.[0]?.diagnosticsStatus === "complete", "SEM08 empty diagnostics lacked completed status");
    await writeFile(join(workspace, "clean.py"), pyErrorText, "utf8");
    const errors = await pyAdapter.read(request("diagnostics", null, "clean.py"), context);
    assert(errors.outcome !== "empty" && errors.evidence.length > 0, `SEM08 expected diagnostic evidence: ${JSON.stringify(errors)}`);
    assert(errors.evidence.every((entry) => entry.kind === "diagnostic"), "SEM08 diagnostic result was not typed diagnostic evidence");
    const pyErrorBytes = Buffer.from(pyErrorText, "utf8");
    const badBytes = Buffer.from("\"bad\"", "utf8");
    const badStart = pyErrorBytes.indexOf(badBytes);
    const badDiagnostic = errors.evidence.find((entry) => anchorExcerpt(pyErrorBytes, entry.anchor) === "\"bad\"");
    assert(badStart >= 0 && badDiagnostic?.anchor?.span.startByte === badStart && badDiagnostic.anchor.span.endByte === badStart + badBytes.length, `SEM04 diagnostic UTF-16-after-surrogate conversion was not exact: ${JSON.stringify({ badStart, badDiagnostic })}`);
    await writeFile(join(workspace, "clean.py"), pyText, "utf8");
    const cleanAgain = await pyAdapter.read(request("diagnostics", null, "clean.py"), context);
    assert(cleanAgain.outcome === "empty" && cleanAgain.evidence.length === 0 && cleanAgain.issues.length === 0 && cleanAgain.semanticObservations?.[0]?.diagnosticsStatus === "complete", `SEM08 same-file clean-after-error was not completed empty: ${JSON.stringify(cleanAgain)}`);
    const silent = await silentAdapter.read(request("diagnostics", null, "clean.py"), context);
    cases["SEM-08-controlled"] = { status: "PASS", observations: { error_push: controlledError, empty_push: controlledEmpty, pull_error: pullError, pull_empty: pullEmpty, pull_profile: pullProfile } };
    assert(silent.outcome !== "empty" && silent.semanticObservations?.[0]?.diagnosticsStatus !== "complete" && silent.issues.length > 0, `SEM08 silent push-only protocol was falsely completed empty: ${JSON.stringify(silent)}`);
    assert(clean.semanticObservations?.[0]?.serverProfileDigest === pyProfile && errors.semanticObservations?.[0]?.serverProfileDigest === pyProfile && cleanAgain.semanticObservations?.[0]?.serverProfileDigest === pyProfile, `SEM08 Pyright profile was not stable across same-file lifecycle: ${JSON.stringify({ clean, errors, cleanAgain, expected: pyProfile })}`);
    assert(silent.semanticObservations?.[0]?.serverProfileDigest === silentProfile && tsProfile !== pyProfile && pyProfile !== silentProfile, `SEM03/SEM08 profiles were not distinct configured profiles: ${JSON.stringify({ tsProfile, pyProfile, silentProfile, silent })}`);
    cases["SEM-08"] = { status: "PASS", observations: { no_diagnostic_message: silent, controlled_protocol_fixture: "silent push-only LSP: no publishDiagnostics and pull request rejected", completed_empty: cleanAgain, error_report: errors, real_pyright_clean: clean } };
    return { schema_version: 1, status: "PASS", criteria: cases, pre_fix_failures: [{ case: "SEM02", observed: { outcome: "error", issue: "worker_failed: Found multiple 4 symbols matching 'parse'" } }, { case: "SEM02-containing-anchor", observed: { outcome: "ok", evidence_count: 1, related_anchors: [] } }], commands: ["npm --prefix packages/core run build", "node --test test/semantic-negative.test.js", "node scripts/verify-semantic.mjs --write"], source_identity: { serena_commit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd", typescript_language_server: tsls, pyright_language_server: pyright }, source_integrity: { semantic_adapter_sha256: sha256(await readFile(join(ROOT, "packages/core/src/adapters/semantic.ts"))), serena_facade_sha256: sha256(await readFile(join(ROOT, "vendor/serena/src/serena/lazy_read_api.py"))) }, cleanup: "temporary fixture removed after live calls" };
  } finally {
    await Promise.allSettled([tsAdapter.close(), pyAdapter.close(), silentAdapter.close(), diagnosticsPushAdapter.close(), pullAdapter.close()]);
    await rm(workspace, { recursive: true, force: true });
  }
}
const outputPath = process.argv.includes("--write") ? resolve(ROOT, "docs/unified/semantic-evidence.json") : null;
try { const report = await main(); if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2)); } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
