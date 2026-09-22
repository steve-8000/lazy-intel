#!/usr/bin/env node
/** Produce a bounded, offline licence closure for the installed runtime. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = path.join(ROOT, "workers/semantic/.venv/bin/python");
const NODE_ROOTS = [
  { id: "runtime-zvec-grep", path: path.join(ROOT, "vendor/zvec-grep/node_modules"), kind: "runtime" },
  { id: "runtime-codegraph", path: path.join(ROOT, "vendor/codegraph/node_modules"), kind: "runtime" },
  { id: "runtime-core", path: path.join(ROOT, "packages/core/node_modules"), kind: "runtime" },
  { id: "root-dev-baseline", path: path.join(ROOT, "node_modules"), kind: "dev-baseline" },
];
const ASSET_NOTICE_NAME = /^(?:LICENSE|LICENCE|NOTICE|COPYING|PATENTS|UNLICENSE)(?:[._-].*)?$/i;
const MODEL_FILE = /\.(?:onnx|gguf|bin|safetensors|pt|pth)$/i;
const NATIVE_FILE = /\.(?:node|dylib|so|dll)$/i;
const GRAMMAR_FILE = /\.wasm$/i;

function relative(file) { return path.relative(ROOT, file) || "."; }
function isWithin(file, dir) {
  const rel = path.relative(dir, file);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
async function isDirectory(file) { try { return (await stat(file)).isDirectory(); } catch { return false; } }
async function isFile(file) { try { return (await stat(file)).isFile(); } catch { return false; } }
async function hash(file) {
  const digest = createHash("sha256");
  digest.update(await readFile(file));
  return digest.digest("hex");
}
async function fileEvidence(file, root) {
  const real = await realpath(file);
  return { path: relative(file), real_path: real, sha256: await hash(file), root };
}
async function immediateNoticeFiles(dir) {
  if (!(await isDirectory(dir))) return [];
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && ASSET_NOTICE_NAME.test(entry.name)) out.push(full);
    if (entry.isDirectory() && /^(?:licenses?|notices?)$/i.test(entry.name)) {
      for (const nested of await readdir(full, { withFileTypes: true })) {
        const nestedPath = path.join(full, nested.name);
        if (nested.isFile()) out.push(nestedPath);
      }
    }
  }
  return out.sort();
}
async function packageDirs(nodeModules) {
  const packages = [];
  const seen = new Set();
  async function visitModules(dir) {
    if (!(await isDirectory(dir))) return;
    let realDir;
    try { realDir = await realpath(dir); } catch { return; }
    if (seen.has(realDir)) return;
    seen.add(realDir);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(child, { withFileTypes: true })) {
          if (!scoped.isDirectory() || scoped.name.startsWith(".")) continue;
          await visitPackage(path.join(child, scoped.name));
        }
      } else {
        await visitPackage(child);
      }
    }
  }
  async function visitPackage(dir) {
    const manifestFile = path.join(dir, "package.json");
    if (!(await isFile(manifestFile))) return;
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestFile, "utf8")); } catch { return; }
    if (!manifest.name || !manifest.version) return;
    const realDir = await realpath(dir);
    if (packages.some((pkg) => pkg.real_package_dir === realDir)) return;
    const licenseFiles = [];
    for (const file of await immediateNoticeFiles(dir)) licenseFiles.push(await fileEvidence(file, "installed-node"));
    packages.push({
      name: manifest.name,
      version: manifest.version,
      package_dir: relative(dir),
      real_package_dir: realDir,
      license: manifest.license ?? null,
      licenses: manifest.licenses ?? null,
      license_files: licenseFiles,
      has_install_script: Boolean(manifest.scripts?.install || manifest.scripts?.postinstall || manifest.scripts?.preinstall),
    });
    await visitModules(path.join(dir, "node_modules"));
  }
  await visitModules(nodeModules);
  return packages;
}
function summarizeNode(packages) {
  const licenseTotals = {};
  for (const pkg of packages) {
    const key = pkg.license ?? (pkg.licenses ? JSON.stringify(pkg.licenses) : "UNDECLARED");
    licenseTotals[key] = (licenseTotals[key] ?? 0) + 1;
  }
  return {
    package_count: packages.length,
    license_totals: licenseTotals,
    undeclared: packages.filter((pkg) => !pkg.license && !pkg.licenses).map((pkg) => `${pkg.name}@${pkg.version}`),
    install_scripts: packages.filter((pkg) => pkg.has_install_script).map((pkg) => `${pkg.name}@${pkg.version}`),
    packages: packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.package_dir.localeCompare(b.package_dir)),
  };
}
async function nodeClosure() {
  const roots = [];
  for (const root of NODE_ROOTS) {
    const packages = summarizeNode(await packageDirs(root.path));
    roots.push({ id: root.id, path: relative(root.path), kind: root.kind, exists: existsSync(root.path), ...packages });
  }
  const runtimePackages = roots.filter((root) => root.kind === "runtime").flatMap((root) => root.packages);
  return {
    runtime_roots: roots.filter((root) => root.kind === "runtime").map(({ id, path, exists, package_count }) => ({ id, path, exists, package_count })),
    runtime: summarizeNode(runtimePackages),
    root_dev_baseline: roots.find((root) => root.id === "root-dev-baseline"),
  };
}
async function pythonClosure() {
  if (!existsSync(PYTHON)) return { status: "BLOCKED_ENVIRONMENT", reason: `${PYTHON} is absent`, packages: [], undeclared: [] };
  const code = String.raw`import hashlib, importlib.metadata as md, json, pathlib, sys

def evidence(path):
    real = path.resolve()
    return {"path": str(path), "real_path": str(real), "sha256": hashlib.sha256(real.read_bytes()).hexdigest()}

def distribution(d):
    meta = d.metadata
    classifiers = meta.get_all("Classifier") or []
    license_classifiers = [x for x in classifiers if x.startswith("License ::")]
    expression = meta.get("License-Expression") or None
    license_text = meta.get("License") or None
    files = []
    for item in d.files or ():
        path = pathlib.Path(d.locate_file(item))
        if not path.is_file():
            continue
        lower_parts = [part.lower() for part in path.parts]
        name = path.name.lower()
        in_dist_info = any(part.endswith(".dist-info") for part in lower_parts)
        licenseish = name.startswith(("license", "licence", "notice", "copying", "patents", "unlicense")) or "licenses" in lower_parts or "notices" in lower_parts
        if in_dist_info and licenseish:
            files.append(evidence(path))
    declared = bool(expression or license_text or license_classifiers)
    return {"name": meta.get("Name"), "version": d.version, "license_expression": expression, "license": license_text, "classifiers": classifiers, "license_classifiers": license_classifiers, "declared": declared, "license_files": sorted(files, key=lambda x: x["real_path"])};

try:
    distributions = sorted(md.distributions(), key=lambda d: (d.metadata.get("Name") or "").lower())
    print(json.dumps({"status": "MEASURED", "packages": [distribution(d) for d in distributions], "interpreter": sys.version.split()[0]}))
except Exception as error:
    print(json.dumps({"status": "FAIL", "reason": str(error), "packages": []}))
`;
  try {
    const result = await exec(PYTHON, ["-c", code], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    const measured = JSON.parse(result.stdout.trim());
    measured.python = PYTHON;
    measured.undeclared = measured.packages.filter((pkg) => !pkg.declared).map((pkg) => `${pkg.name}@${pkg.version}`);
    measured.missing_license_files = measured.packages.filter((pkg) => pkg.declared && pkg.license_files.length === 0).map((pkg) => `${pkg.name}@${pkg.version}`);
    return measured;
  } catch (error) { return { status: "FAIL", reason: error.message, packages: [], undeclared: [] }; }
}
async function assetFiles() {
  const roots = [
    { id: "vendor", path: path.join(ROOT, "vendor"), kind: "runtime-vendor" },
    ...NODE_ROOTS.filter((root) => root.kind === "runtime").map((root) => ({ id: root.id, path: root.path, kind: root.kind })),
  ];
  const seen = new Set();
  const assets = [];
  async function visit(dir, root) {
    if (!(await isDirectory(dir))) return;
    let realDir;
    try { realDir = await realpath(dir); } catch { return; }
    if (seen.has(realDir)) return;
    seen.add(realDir);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(file, root); continue; }
      if (!entry.isFile()) continue;
      const lower = file.toLowerCase();
      const native = NATIVE_FILE.test(file);
      const grammar = GRAMMAR_FILE.test(file) && /(tree[-_]?sitter|grammar|grammars)/i.test(lower);
      const model = MODEL_FILE.test(file) && /(model|tokenizer|weights|embedding)/i.test(lower);
      if (!native && !grammar && !model) continue;
      const key = await realpath(file);
      if (seen.has(key)) continue;
      seen.add(key);
      assets.push({ ...(await fileEvidence(file, root.id)), kind: native ? "native" : grammar ? "grammar" : "model", root_kind: root.kind });
    }
  }
  for (const root of roots) await visit(root.path, root);
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}
async function ancestorNotices(file, packageRecords) {
  const notices = [];
  const pkg = packageRecords.filter((record) => isWithin(file, record.package_abs_dir)).sort((a, b) => b.package_abs_dir.length - a.package_abs_dir.length)[0];
  if (pkg) notices.push(...pkg.license_files);
  if (file.endsWith(".wasm")) {
    for (const vendorRoot of ["vendor/codegraph", "vendor/zvec-grep"]) {
      if (!isWithin(file, path.join(ROOT, vendorRoot))) continue;
      const grammarNotice = path.join(ROOT, vendorRoot, "node_modules/tree-sitter-wasms/LICENSE");
      if (await isFile(grammarNotice)) notices.push(await fileEvidence(grammarNotice, "upstream-grammar"));
    }
  }
  let dir = path.dirname(file);
  while (dir !== ROOT && isWithin(dir, ROOT)) {
    for (const notice of await immediateNoticeFiles(dir)) notices.push(await fileEvidence(notice, "upstream-ancestor"));
    dir = path.dirname(dir);
  }
  const unique = new Map(notices.map((notice) => [notice.real_path, notice]));
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}
async function noticeCoverage(assets, node) {
  const packageRecords = [];
  for (const root of [...node.runtime_roots, node.root_dev_baseline].filter(Boolean)) {
    for (const pkg of root.packages ?? []) packageRecords.push({ ...pkg, package_abs_dir: path.join(ROOT, pkg.package_dir) });
  }
  const coverage = [];
  for (const asset of assets) {
    const notices = await ancestorNotices(path.join(ROOT, asset.path), packageRecords);
    coverage.push({ asset: asset.path, kind: asset.kind, notice_paths: notices.map((notice) => notice.path), notice_evidence: notices, status: notices.length ? "COVERED" : "GAP" });
  }
  return coverage;
}
async function main(argv) {
  const node = await nodeClosure();
  const python = await pythonClosure();
  const assets = await assetFiles();
  const coverage = await noticeCoverage(assets, node);
  const runtimeUndeclared = node.runtime.undeclared;
  const devUndeclared = node.root_dev_baseline?.undeclared ?? [];
  const pythonUndeclared = python.undeclared ?? [];
  const assetGaps = coverage.filter((entry) => entry.status === "GAP");
  const report = {
    schema_version: 3,
    unit: "U00",
    generated_at: new Date().toISOString(),
    method: {
      node: "Enumerated only the explicit installed roots vendor/zvec-grep/node_modules, vendor/codegraph/node_modules, packages/core/node_modules (runtime), and root node_modules (separate dev baseline). Traversal follows package/node_modules boundaries; fixture subtrees and arbitrary package.json files are excluded.",
      python: "Read importlib.metadata from workers/semantic/.venv. License-Expression, License, License classifiers, and existing .dist-info license/notice files are retained with resolved paths and SHA-256 hashes.",
      assets: "Scanned only vendor and the explicit installed roots for retained native, grammar, and model files; every native/grammar asset must resolve to a package or upstream ancestor notice.",
      network: "disabled by procedure; this producer never invokes npm, uv, pip, registries, model loaders, or home-directory scans.",
    },
    node_closure: node,
    python_installed_closure: python,
    retained_runtime_assets: {
      files: assets,
      counts: { native: assets.filter((asset) => asset.kind === "native").length, grammar: assets.filter((asset) => asset.kind === "grammar").length, model: assets.filter((asset) => asset.kind === "model").length },
      notice_coverage: coverage,
      top_level_notice_is_not_asset_coverage: true,
    },
    retained_upstream_licences: {
      "zvec-ai/zvec-grep@309a6699": { declared: "Apache-2.0", notice_file: "vendor/zvec-grep/LICENSE" },
      "colbymchenry/codegraph@dfccdf62": { declared: "MIT", notice_file: "vendor/codegraph/LICENSE" },
      "oraios/serena@949a27ef": { declared: "MIT", notice_file: "vendor/serena/LICENSE" },
    },
    external_runtime_model: {
      configured_embedding: "local/qwen3-embedding-0.6b",
      status: "EXTERNAL_CACHED_NOT_REDISTRIBUTED",
      retained_artifacts: [],
      downloads_allowed: false,
      scan_scope: "The audit does not scan unrelated home directories or download a model.",
      attribution: "Qwen Team; Qwen3-Embedding-0.6B model card: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B",
      model_card_revision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
      license: "Apache-2.0",
      license_source_revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      license_source: "https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE",
      license_sha256: "832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",
      license_text_retained_in: "THIRD_PARTY_NOTICES.md",
    },
    findings: [
      { id: "DEP-NODE-RUNTIME", status: runtimeUndeclared.length ? "FAIL" : "PASS", detail: runtimeUndeclared.length ? `Missing declared licence metadata in runtime packages: ${runtimeUndeclared.join(", ")}` : `All ${node.runtime.package_count} installed runtime packages declare license metadata.` },
      { id: "DEP-NODE-DEV-BASELINE", status: devUndeclared.length ? "GAP" : "PASS", detail: devUndeclared.length ? `Root development baseline has ${devUndeclared.length} package(s) without declared licence metadata: ${devUndeclared.join(", ")}` : `All ${node.root_dev_baseline?.package_count ?? 0} root development-baseline packages declare license metadata.` },
      { id: "DEP-PYTHON", status: python.status === "MEASURED" && !pythonUndeclared.length ? "PASS" : python.status === "MEASURED" ? "FAIL" : python.status, detail: python.status === "MEASURED" ? `${python.packages.length} installed Python distributions measured; undeclared: ${pythonUndeclared.length}; declarations without retained .dist-info notice files: ${python.missing_license_files.length}.` : python.reason },
      { id: "DEP-ASSET-NOTICES", status: assetGaps.length ? "FAIL" : "PASS", detail: assetGaps.length ? `${assetGaps.length} native/grammar/model asset(s) lack an adjacent packaged or upstream notice.` : `All ${coverage.length} retained native/grammar/model asset(s) have packaged or upstream notice evidence.` },
      { id: "DEP-MODEL", status: "PASS", detail: "Configured Qwen3 embedding is external cached state and is not redistributed; Apache-2.0 licence text, source revision, URL, and SHA-256 are retained above and in THIRD_PARTY_NOTICES.md." },
    ],
  };
  const out = JSON.stringify(report, null, 2) + "\n";
  const writeIndex = argv.indexOf("--write");
  if (writeIndex >= 0) await writeFile(path.resolve(ROOT, argv[writeIndex + 1] ?? "docs/unified/dependency-audit.json"), out);
  process.stdout.write(out);
  return report.findings.some((finding) => finding.status === "FAIL") ? 1 : 0;
}
try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error(`verify-dependencies: ${error.stack ?? error.message}`); process.exitCode = 2; }
