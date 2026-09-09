#!/usr/bin/env node
// Real pinned backends in one disposable source workspace; no model/provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../src/mcp/client.js';
import { resolveBin, run } from '../src/lib/process.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'lazy-intel-compat-'));
const pins = JSON.parse(await readFile(path.join(repo, 'upstreams.lock.json'), 'utf8')).upstreams;
const report = { status: 'FAIL', versions: {}, operations: [], latencyMs: {}, scope: 'Real local pinned backends; disposable two-file JavaScript workspace; no model calls. Restart latency is one sample, not a benchmark percentile.' };
let client;
const open = async () => {
  client = new StdioMcpClient(process.execPath, [path.join(repo, 'src/cli.js'), 'serve'], {
    cwd: root, timeoutMs: 900000,
    env: { LAZY_INTEL_ROOT: root, LAZY_INTEL_ALLOWED_ROOTS: '', LAZY_INTEL_AUTO_INDEX: 'false', LAZY_INTEL_MAINTENANCE_MS: '0' },
  });
  await client.start();
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['code_intel']);
};
const query = async (operation, args) => {
  const started = performance.now();
  const result = await client.callTool('code_intel', { operation, root, ...args, indexTimeoutMs: 600000, timeoutMs: 120000 });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(result.structuredContent.backends.every(backend => backend.ok), JSON.stringify(result.structuredContent));
  report.operations.push(operation);
  return { text: result.content.map(block => block.text ?? '').join('\n'), ms: Math.round(performance.now() - started) };
};
try {
  for (const [name, key, args] of [['zg', 'zvec-grep', ['version']], ['codegraph', 'codegraph', ['version']], ['serena', 'serena', ['--version']]]) {
    const result = await run(await resolveBin(name), args, { timeoutMs: 30000 });
    const version = (result.stdout || result.stderr).match(/\d+\.\d+\.\d+/)?.[0];
    assert.equal(version, pins[key].version, `${name} compatibility pin`);
    report.versions[key] = version;
  }
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(root, 'jsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['*.mjs'] }));
  await writeFile(path.join(root, '.gitignore'), '.zvec-grep/\n.codegraph/\n.serena/\n');
  await run('git', ['init', '--quiet', root]);
  await writeFile(path.join(root, 'discount.mjs'), '// Percentage discounts reduce an invoice amount in integer cents.\nexport function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n');
  await writeFile(path.join(root, 'invoice.mjs'), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");
  await open();
  const search = await query('search', { query: 'percentage discount invoice cents' });
  assert.match(search.text, /discount\.mjs/); report.latencyMs.firstSearch = search.ms;
  assert.match((await query('architecture', { query: 'invoiceTotal calls applyDiscount' })).text, /invoiceTotal/);
  assert.match((await query('impact', { symbol: 'applyDiscount' })).text, /invoice/);
  assert.match((await query('references', { symbol: 'applyDiscount', relativePath: 'discount.mjs' })).text, /invoice\.mjs/);
  assert.match((await query('symbol', { symbol: 'applyDiscount', relativePath: 'discount.mjs', includeBody: true })).text, /100 - percent/);
  client.close(); await new Promise(resolve => client.child.once('close', resolve));
  await open();
  const restarted = await query('search', { query: 'percentage discount invoice cents' });
  assert.match(restarted.text, /discount\.mjs/); report.latencyMs.restartFirstSearch = restarted.ms;
  report.latencyMs.warmSearch = (await query('search', { query: 'percentage discount invoice cents' })).ms;
  report.status = 'PASS';
} finally {
  if (client && !client.closed) { client.close(); await new Promise(resolve => client.child.once('close', resolve)); }
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
