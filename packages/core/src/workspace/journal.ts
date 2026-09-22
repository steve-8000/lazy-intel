import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type JournalOperation = "replace" | "delete" | "rebind";

export interface JournalIntent<T = unknown> { readonly type: "intent"; readonly operationId: string; readonly operation: JournalOperation; readonly payload: T; }
export interface JournalAck<T = unknown> { readonly type: "ack"; readonly operationId: string; readonly operation: JournalOperation; readonly payload?: T; }
export type JournalEntry = JournalIntent | JournalAck;
export type JournalRecord = JournalEntry & { readonly seq: string; readonly checksum: string };
export interface JournalScan { readonly records: readonly JournalRecord[]; readonly discardedTrailingBytes: number; readonly discardedTrailingRecords: number; }
export interface JournalReplayHandlers { readonly replace?: (payload: unknown, operationId: string) => Promise<void> | void; readonly delete?: (payload: unknown, operationId: string) => Promise<void> | void; readonly rebind?: (payload: unknown, operationId: string) => Promise<void> | void; }

function checksum(entry: Omit<JournalRecord, "checksum">): string { return createHash("sha256").update(JSON.stringify(entry)).digest("hex"); }
function encode(record: JournalRecord): string { return `${JSON.stringify(record)}\n`; }

function parseRecord(line: string): JournalRecord {
  const record = JSON.parse(line) as JournalRecord;
  if (!record || typeof record !== "object" || (record.type !== "intent" && record.type !== "ack") || typeof record.seq !== "string" || typeof record.operationId !== "string" || typeof record.operation !== "string" || typeof record.checksum !== "string") throw new Error("invalid journal record");
  const { checksum: ignored, ...withoutChecksum } = record;
  if (checksum(withoutChecksum) !== record.checksum) throw new Error("journal checksum mismatch");
  return record;
}

async function writeJournal(filePath: string, records: readonly JournalRecord[]): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = filePath + "." + process.pid + "." + randomUUID();
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(records.map(encode).join(""), "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
  const directoryHandle = await open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

async function scanFile(filePath: string): Promise<JournalScan> {
  let bytes: Buffer;
  try { bytes = await readFile(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], discardedTrailingBytes: 0, discardedTrailingRecords: 0 };
    throw error;
  }
  const text = bytes.toString("utf8");
  let validEnd = 0;
  const records: JournalRecord[] = [];
  let discardedTrailingRecords = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length === 0) continue;
    try {
      const parsed = parseRecord(line);
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        discardedTrailingRecords += 1;
        break;
      }
      records.push(parsed);
      validEnd += Buffer.byteLength(line) + 1;
    } catch {
      const trailing = lines.slice(index + 1).every((next) => next.length === 0);
      if (!trailing) throw new Error(`corrupt journal record at line ${index + 1}`);
      discardedTrailingRecords += 1;
      break;
    }
  }
  const discardedTrailingBytes = bytes.byteLength - validEnd;
  if (discardedTrailingBytes > 0) await writeJournal(filePath, records);
  return { records, discardedTrailingBytes, discardedTrailingRecords };
}

export class WorkspaceJournal {
  readonly filePath: string;
  private nextSeq: bigint = 1n;
  private opened = false;
  private records: JournalRecord[] = [];
  private discardedTrailingBytes = 0;
  private discardedTrailingRecords = 0;
  private constructor(filePath: string) { this.filePath = filePath; }

  static async open(filePath: string): Promise<WorkspaceJournal> {
    const journal = new WorkspaceJournal(filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    const scan = await scanFile(filePath);
    journal.records = [...scan.records];
    journal.discardedTrailingBytes = scan.discardedTrailingBytes;
    journal.discardedTrailingRecords = scan.discardedTrailingRecords;
    const last = journal.records.at(-1);
    if (last) journal.nextSeq = BigInt(last.seq) + 1n;
    journal.opened = true;
    return journal;
  }

  get recoveryInfo(): { readonly discardedTrailingBytes: number; readonly discardedTrailingRecords: number } { return { discardedTrailingBytes: this.discardedTrailingBytes, discardedTrailingRecords: this.discardedTrailingRecords }; }
  get entries(): readonly JournalRecord[] { return this.records; }

  private async append(entry: JournalEntry): Promise<JournalRecord> {
    if (!this.opened) throw new Error("journal is not open");
    const withoutChecksum = { ...entry, seq: this.nextSeq.toString() };
    const record = { ...withoutChecksum, checksum: checksum(withoutChecksum) } as JournalRecord;
    const handle = await open(this.filePath, "a", 0o600);
    try { await handle.writeFile(encode(record), "utf8"); await handle.sync(); } finally { await handle.close(); }
    this.records.push(record);
    this.nextSeq += 1n;
    return record;
  }

  async appendIntent<T>(operation: JournalOperation, payload: T, operationId = randomUUID()): Promise<JournalIntent<T> & { readonly seq: string }> {
    const record = await this.append({ type: "intent", operationId, operation, payload });
    return record as JournalIntent<T> & { readonly seq: string };
  }

  async appendAck<T>(intent: Pick<JournalIntent<T>, "operationId" | "operation">, payload?: T): Promise<JournalAck<T> & { readonly seq: string }> {
    const entry: JournalAck<T> = payload === undefined ? { type: "ack", operationId: intent.operationId, operation: intent.operation } : { type: "ack", operationId: intent.operationId, operation: intent.operation, payload };
    const record = await this.append(entry);
    return record as JournalAck<T> & { readonly seq: string };
  }

  async compact(keep: (record: JournalRecord) => boolean): Promise<void> {
    if (!this.opened) throw new Error("journal is not open");
    const retained = this.records.filter(keep);
    if (retained.length === this.records.length) return;
    await writeJournal(this.filePath, retained);
    this.records = retained;
  }


  async replay(handlers: JournalReplayHandlers): Promise<readonly string[]> {
    const acknowledged = new Set(this.records.filter((record) => record.type === "ack").map((record) => record.operationId));
    const replayed: string[] = [];
    for (const record of this.records) {
      if (record.type !== "intent" || acknowledged.has(record.operationId)) continue;
      const handler = handlers[record.operation];
      if (!handler) throw new Error(`no replay handler for ${record.operation}`);
      await handler(record.payload, record.operationId);
      await this.appendAck(record);
      replayed.push(record.operationId);
    }
    return replayed;
  }
}

export async function openWorkspaceJournal(filePath: string): Promise<WorkspaceJournal> { return WorkspaceJournal.open(filePath); }

export async function inspectWorkspaceJournal(filePath: string): Promise<JournalScan> {
  try { await stat(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], discardedTrailingBytes: 0, discardedTrailingRecords: 0 };
    throw error;
  }
  return scanFile(filePath);
}
