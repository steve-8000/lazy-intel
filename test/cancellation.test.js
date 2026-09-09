import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StdioMcpClient } from "../src/mcp/client.js";

const base = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-cancel-"));
const executable = path.join(base, "serena");
const server = `import readline from 'node:readline';
const active = new Set(), cancelled = [], waiting = [];
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const text = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line), name=m.params?.arguments?.name_path_pattern ?? m.params?.name;
 if(m.method==='notifications/cancelled') { cancelled.push(m.params.requestId);active.delete(m.params.requestId);return; }
 if(m.id == null) return;
 if(m.method==='initialize') return send(m.id,{});
 if(m.method==='tools/list') return send(m.id,{tools:['find_symbol','find_referencing_symbols','find_implementations','get_symbols_overview','get_diagnostics_for_file'].map(name=>({name}))});
 if(name==='slow') { active.add(m.id);for(const id of waiting.splice(0))send(id,text({pid:process.pid,active:[...active]}));return; }
 if(name==='await-started' && !active.size) {waiting.push(m.id);return;}
 send(m.id,text({pid:process.pid,active:[...active],cancelled}));
});`;
await writeFile(executable, `#!${process.execPath}\n${server}`, { mode: 0o755 });
process.env.LAZY_INTEL_SERENA_BIN = executable;
process.env.LAZY_INTEL_ROOT = base;
process.env.LAZY_INTEL_MAINTENANCE_MS = "0";
const { codeIntel } = await import("../src/engine.js");
const { closeSerena } = await import("../src/backends/serena.js");
after(async () => { closeSerena(); await rm(base, { recursive: true, force: true }); });
const value = result => JSON.parse(result.content[0].text);

async function client(t) {
  const c = new StdioMcpClient(process.execPath, ["--input-type=module", "-e", server]);
  t.after(() => c.close()); await c.start(); return c;
}

test("abort cancels only the dispatched MCP request and keeps the connection usable", async t => {
  const c = await client(t), controller = new AbortController();
  const pending = c.callTool("slow", {}, { signal: controller.signal }).then(() => null, error => error);
  const started = value(await c.callTool("await-started", {}));
  controller.abort();
  assert.equal((await pending).name, "AbortError");
  const state = value(await c.callTool("state", {}));
  assert.deepEqual(state.cancelled, started.active);
  assert.deepEqual(state.active, []);
  assert.equal(state.pid, started.pid);
});

test("pre-aborted requests are not sent and timeout cancellation releases remote work", async t => {
  const c = await client(t);
  await assert.rejects(c.callTool("slow", {}, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual(value(await c.callTool("state", {})).active, []);
  const pending = c.callTool("slow", {}, { timeoutMs: 100 }).then(() => null, error => error);
  const started = value(await c.callTool("await-started", {}));
  assert.match((await pending).message, /MCP timeout/);
  assert.deepEqual(value(await c.callTool("state", {})).cancelled, started.active);
});

test("engine cancellation reaches Serena without retrying or replacing a shared client", async () => {
  const controller = new AbortController();
  const query = symbol => ({ operation: "symbol", symbol, root: base });
  const pending = codeIntel(query("slow"), controller.signal).then(() => null, error => error);
  // Concurrent startup must join the same client rather than spawn one backend per caller.
  const startedResult = await codeIntel(query("await-started"));
  const started = JSON.parse(startedResult.text.match(/\{"pid"[^\n]+/)[0]);
  controller.abort();
  assert.equal((await pending).name, "AbortError");
  const result = await codeIntel(query("state"));
  const state = JSON.parse(result.text.match(/\{"pid"[^\n]+/)[0]);
  assert.equal(state.pid, started.pid);
  assert.deepEqual(state.cancelled, started.active);
  assert.deepEqual(state.active, []);
  closeSerena();
});
