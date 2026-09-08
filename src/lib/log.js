export function log(level, message, fields = {}) {
  if (process.env.LAZY_INTEL_LOG === "off") return;
  const record = { ts: new Date().toISOString(), level, message, ...fields };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
