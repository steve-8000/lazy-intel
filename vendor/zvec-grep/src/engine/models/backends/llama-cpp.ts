import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { EngineError } from "../../errors.js";
import type { Content, TextContent } from "../../types.js";
import { defaultHome } from "../../utils/path.js";
import {
  BaseEmbeddingModel,
  type CreateEmbeddingModelOptions,
  type EmbeddingModelProgress,
  type EmbeddingModelInfo,
  type EmbeddingResult,
  type NormalizedEmbeddingOptions,
} from "../embeddings.js";
import type { LlamaCppEmbeddingCatalogEntry } from "../catalog.js";
import {
  createModelDownloadProgressReporter,
  type ModelDownloadProgressReporter,
} from "../download-progress.js";

type LlamaEmbedding = {
  vector: ArrayLike<number>;
};

type LlamaEmbeddingContext = {
  getEmbeddingFor(text: string): Promise<LlamaEmbedding>;
  dispose?(): Promise<void> | void;
};

type LlamaModel = {
  trainContextSize?: number;
  tokenize?(text: string): readonly unknown[];
  detokenize?(tokens: readonly unknown[]): string;
  fileInsights?: {
    estimateContextResourceRequirements?: (options: { contextSize: number; isEmbeddingContext: boolean; sequences: number }) => { cpuRam?: number; gpuVram?: number } | Promise<{ cpuRam?: number; gpuVram?: number }>;
  };
  createEmbeddingContext(
    options: Record<string, unknown>,
  ): Promise<LlamaEmbeddingContext>;
  dispose?(): Promise<void> | void;
};

type Llama = {
  gpu: string | false;
  cpuMathCores?: number;
  supportsGpuOffloading?: boolean;
  getVramState?(): Promise<{ total: number; used: number; free: number }>;
  loadModel(options: {
    modelPath: string;
    gpuLayers?: number;
  }): Promise<LlamaModel>;
  dispose?(): Promise<void> | void;
};

type LlamaGpuSelection =
  Exclude<NonNullable<CreateEmbeddingModelOptions["device"]>, "cpu"> | false;

type NodeLlamaCppModule = {
  getLlama(options: Record<string, unknown>): Promise<Llama>;
  resolveModelFile(
    model: string,
    options: {
      directory: string;
      cli?: boolean;
      onProgress?: (status: {
        totalSize: number;
        downloadedSize: number;
      }) => void;
    },
  ): Promise<string>;
  LlamaLogLevel?: { error?: unknown };
};

type NodeLlamaCppLoader = () => Promise<NodeLlamaCppModule>;
type LlamaCppRuntimeState = {
  failedGpuInitModes: Set<LlamaGpuSelection>;
  cpuCompatibleFallbackWarningShown: boolean;
};
type LlamaCppDependencies = {
  loadRuntime: NodeLlamaCppLoader;
  runtimeState: LlamaCppRuntimeState;
};

const DEFAULT_MODEL_CACHE_DIR = join(defaultHome(), "models");
const GGUF_MAGIC = Buffer.from("GGUF");
const DEFAULT_PARALLELISM_CAP = 8;
const DEFAULT_EMBEDDING_CONTEXT_BUDGET_BYTES = 1024 * 1024 * 1024;
const EMBEDDING_CONTEXT_BUCKETS = [512, 1024, 2048, 4096, 8192] as const;
const DEFAULT_DARWIN_CMAKE_OPTIONS = {
  GGML_OPENMP: "OFF",
} as const;
const DEFAULT_DARWIN_ARM64_CMAKE_OPTIONS = {
  ...DEFAULT_DARWIN_CMAKE_OPTIONS,
  GGML_NATIVE: "OFF",
} as const;
const SUPPRESSED_LLAMA_CPP_LOG_MESSAGES = new Set(["Failed to get swap info"]);

async function defaultNodeLlamaCppLoader(): Promise<NodeLlamaCppModule> {
  const moduleName = "node-llama-cpp";
  try {
    installDarwinMetalResidencyMitigation();
    return (await import(moduleName)) as NodeLlamaCppModule;
  } catch (cause) {
    throw new EngineError(
      "node-llama-cpp is required for local embedding models",
      {
        code: "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_MISSING_DEPENDENCY",
        context:
          "Install optional dependency node-llama-cpp or reinstall zvec-grep with optional dependencies enabled",
        cause,
      },
    );
  }
}

function installDarwinMetalResidencyMitigation(): void {
  if (process.platform !== "darwin") {
    return;
  }

  if (process.env.ZVEC_GREP_METAL_KEEP_RESIDENCY === "1") {
    return;
  }

  process.env.GGML_METAL_NO_RESIDENCY ??= "1";
}

let defaultRuntimeImport: Promise<NodeLlamaCppModule> | null = null;

const defaultDependencies: LlamaCppDependencies = {
  loadRuntime() {
    defaultRuntimeImport ??= defaultNodeLlamaCppLoader();
    return defaultRuntimeImport;
  },
  runtimeState: {
    failedGpuInitModes: new Set<LlamaGpuSelection>(),
    cpuCompatibleFallbackWarningShown: false,
  },
};

export class LlamaCppEmbeddingModel extends BaseEmbeddingModel {
  readonly info: EmbeddingModelInfo;

  private readonly modelCacheDir: string;
  private readonly gpu: LlamaGpuSelection;
  private readonly parallelism?: number;
  private readonly embeddingContextBudgetBytes: number;
  private readonly dependencies: LlamaCppDependencies;

  private runtimeImport: Promise<NodeLlamaCppModule> | null = null;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private contexts: LlamaEmbeddingContext[] = [];
  private contextSize: number | null = null;
  private llamaLoadPromise: Promise<Llama> | null = null;
  private modelLoadPromise: Promise<LlamaModel> | null = null;
  private contextsCreatePromise: Promise<LlamaEmbeddingContext[]> | null = null;
  private embedGate: Promise<void> = Promise.resolve();
  private usingCpuFallback = false;
  private disposed = false;

  constructor(
    private readonly entry: LlamaCppEmbeddingCatalogEntry,
    options: CreateEmbeddingModelOptions,
    dependencies: Partial<LlamaCppDependencies> = {},
  ) {
    super();

    this.info = {
      reference: entry.reference,
      provider: entry.provider,
      name: entry.model,
      dimension: entry.dimension,
      metric: entry.metric,
      inputKinds: ["text"],
      limits: {
        maxBatchSize: entry.maxBatchSize,
        maxInputTokens: entry.contextSize,
      },
    };
    this.modelCacheDir =
      options.modelCacheDir ??
      process.env.ZVEC_GREP_MODEL_CACHE ??
      DEFAULT_MODEL_CACHE_DIR;
    this.gpu = embeddingDeviceToLlamaGpuSelection(options.device ?? "cpu");
    this.parallelism = resolveParallelismOverride(
      process.env.ZVEC_GREP_LLAMA_CONTEXT_PARALLELISM,
    );
    this.embeddingContextBudgetBytes = resolveEmbeddingContextBudget(options.embeddingContextBudgetBytes, process.env.ZVEC_GREP_EMBEDDING_CONTEXT_BUDGET_MB);
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  protected async doEmbed(
    contents: readonly Content[],
    options: NormalizedEmbeddingOptions,
  ): Promise<EmbeddingResult> {
    return await this.embedBatch(contents, options);
  }

  private async embedBatch(
    contents: readonly Content[],
    options: NormalizedEmbeddingOptions,
  ): Promise<EmbeddingResult> {
    this.ensureNotDisposed();
    const texts = (contents as readonly TextContent[]).map((content) =>
      formatTextForEmbedding(content.text, options.purpose, this.entry),
    );

    try {
      return await this.runExclusively(() =>
        this.embedTexts(texts, options.onProgress),
      );
    } catch (cause) {
      throw new EngineError("llama.cpp embedding failed", {
        code: "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_EMBED_FAILED",
        context: `model=${this.entry.reference}`,
        cause,
      });
    }
  }

  override async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    await this.disposeLoadedRuntime();
    this.modelLoadPromise = null;
    this.contextsCreatePromise = null;
  }

  override async releaseIdleResources(): Promise<void> {
    if (this.disposed) return;
    await this.runExclusively(async () => {
      await this.disposeEmbeddingContexts();
    });
  }

  /**
   * Embedding contexts are now sized per batch, so a second concurrent batch that needs a
   * different size would otherwise dispose contexts the first batch is still reading from.
   * Batches on one model therefore acquire and use their contexts exclusively; the parallel
   * work inside a batch is unchanged.
   */
  private runExclusively<T>(task: () => Promise<T>): Promise<T> {
    const run = this.embedGate.then(task, task);
    this.embedGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async embedTexts(
    texts: readonly string[],
    onProgress?: (progress: EmbeddingModelProgress) => void,
  ): Promise<EmbeddingResult> {
    await this.ensureModel(onProgress);
    const truncatedInputIndexes: number[] = [];
    let maxTokens = 0;
    const safeTexts = texts.map((text, index) => {
      const result = this.truncateToContextSize(text);
      maxTokens = Math.max(maxTokens, result.tokenCount);
      if (result.truncated) {
        truncatedInputIndexes.push(index);
      }
      return result.text;
    });
    const requiredContextSize = this.requiredContextSize(maxTokens);
    const contexts = await this.ensureEmbeddingContexts(texts.length, requiredContextSize, onProgress);
    const chunkSize = Math.ceil(texts.length / contexts.length);
    const chunks = contexts
      .map((context, index) => ({
        context,
        texts: safeTexts.slice(index * chunkSize, (index + 1) * chunkSize),
      }))
      .filter((chunk) => chunk.texts.length > 0);

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const vectors: number[][] = [];
        for (const text of chunk.texts) {
          const embedding = await chunk.context.getEmbeddingFor(text);
          vectors.push(Array.from(embedding.vector));
        }
        return vectors;
      }),
    );

    return {
      vectors: results.flat(),
      truncated: truncatedInputIndexes,
    };
  }

  private async ensureLlama(
    downloadProgress?: ModelDownloadProgressReporter,
  ): Promise<Llama> {
    if (this.llama) {
      return this.llama;
    }

    if (this.llamaLoadPromise) {
      return await this.llamaLoadPromise;
    }

    this.llamaLoadPromise = this.loadLlamaWithFallback(downloadProgress);

    try {
      return await this.llamaLoadPromise;
    } finally {
      this.llamaLoadPromise = null;
    }
  }

  private async loadRuntime(): Promise<NodeLlamaCppModule> {
    this.runtimeImport ??= this.dependencies.loadRuntime();
    return await this.runtimeImport;
  }

  private async loadLlamaWithFallback(
    downloadProgress?: ModelDownloadProgressReporter,
  ): Promise<Llama> {
    const runtime = await this.loadRuntime();
    const requestedGpu = this.usingCpuFallback ? false : this.gpu;
    const load = (gpu: LlamaGpuSelection) =>
      runtime.getLlama({
        build: "autoAttempt",
        logLevel: runtime.LlamaLogLevel?.error,
        logger: llamaCppLogger,
        gpu,
        cmakeOptions: defaultLlamaCppCmakeOptions(),
        progressLogs: false,
      });

    if (requestedGpu === false) {
      this.llama = await this.loadCpuCompatibleLlama(load, downloadProgress);
      return this.llama;
    }

    if (this.dependencies.runtimeState.failedGpuInitModes.has(requestedGpu)) {
      reportLlamaWarning(
        downloadProgress,
        `skipping previously failed llama.cpp GPU init${requestedGpu === "auto" ? "" : ` for device=${requestedGpu}`}, using CPU.`,
      );
      this.usingCpuFallback = true;
      this.llama = await this.loadCpuCompatibleLlama(load, downloadProgress);
      return this.llama;
    }

    try {
      this.llama = await load(requestedGpu);
    } catch (error) {
      this.dependencies.runtimeState.failedGpuInitModes.add(requestedGpu);
      reportLlamaWarning(
        downloadProgress,
        `llama.cpp GPU init failed (${formatErrorMessage(error)}), falling back to CPU.`,
      );
      this.usingCpuFallback = true;
      this.llama = await this.loadCpuCompatibleLlama(load, downloadProgress);
    }

    return this.llama;
  }

  private async loadCpuCompatibleLlama(
    load: (gpu: LlamaGpuSelection) => Promise<Llama>,
    downloadProgress?: ModelDownloadProgressReporter,
  ): Promise<Llama> {
    try {
      return await load(false);
    } catch (error) {
      if (!this.dependencies.runtimeState.cpuCompatibleFallbackWarningShown) {
        this.dependencies.runtimeState.cpuCompatibleFallbackWarningShown = true;
        reportLlamaWarning(
          downloadProgress,
          `CPU-only llama.cpp backend unavailable (${formatErrorMessage(error)}); using packaged backend with GPU model offloading disabled.`,
        );
      }
      return await load("auto");
    }
  }

  private async ensureModel(
    onProgress?: (progress: EmbeddingModelProgress) => void,
  ): Promise<LlamaModel> {
    if (this.model) {
      return this.model;
    }

    if (this.modelLoadPromise) {
      return await this.modelLoadPromise;
    }

    this.modelLoadPromise = this.loadModelWithFallback(onProgress);

    try {
      return await this.modelLoadPromise;
    } finally {
      this.modelLoadPromise = null;
    }
  }

  private async loadModelWithFallback(
    onProgress?: (progress: EmbeddingModelProgress) => void,
  ): Promise<LlamaModel> {
    const downloadProgress = createModelDownloadProgressReporter(
      this.entry.reference,
      onProgress,
      [basename(this.entry.uri)],
    );
    downloadProgress.start();
    try {
      const model = await this.loadModel(downloadProgress);
      downloadProgress.finish();
      return model;
    } catch (error) {
      if (!this.canRetryGpuOperationOnCpu()) {
        throw error;
      }

      const warning = `llama.cpp GPU model load failed (${formatErrorMessage(error)}), falling back to CPU.`;
      if (!downloadProgress.warning(warning)) {
        process.stderr.write(`zvec-grep warning: ${warning}\n`);
      }
      this.usingCpuFallback = true;
      await this.disposeLoadedRuntime();
      const model = await this.loadModel(downloadProgress);
      downloadProgress.finish();
      return model;
    }
  }

  private async loadModel(
    downloadProgress: ModelDownloadProgressReporter,
  ): Promise<LlamaModel> {
    const modelPath = await this.resolveModelPath(downloadProgress);
    const llama = await this.ensureLlama(downloadProgress);
    const model = await llama.loadModel(this.modelLoadOptions(modelPath));
    this.model = model;
    return model;
  }

  private modelLoadOptions(modelPath: string): {
    modelPath: string;
    gpuLayers?: number;
  } {
    return {
      modelPath,
      ...(this.shouldDisableModelGpuOffload() ? { gpuLayers: 0 } : {}),
    };
  }

  private async ensureEmbeddingContexts(
    textCount: number, contextSize: number,
    onProgress?: (progress: EmbeddingModelProgress) => void,
  ): Promise<LlamaEmbeddingContext[]> {
    const targetParallelism = await this.resolveEffectiveParallelism(textCount, contextSize);
    if (this.contexts.length > 0 && this.contextSize !== contextSize) await this.disposeEmbeddingContexts();
    if (this.contexts.length >= targetParallelism) {
      return this.contexts.slice(0, targetParallelism);
    }

    if (this.contextsCreatePromise) {
      await this.contextsCreatePromise;
      if (this.contexts.length >= targetParallelism) {
        return this.contexts.slice(0, targetParallelism);
      }
    }

    this.contextsCreatePromise = this.createEmbeddingContextsWithFallback(
      targetParallelism,
      contextSize,
      onProgress,
    );

    try {
      await this.contextsCreatePromise;
      return this.contexts.slice(0, targetParallelism);
    } finally {
      this.contextsCreatePromise = null;
    }
  }

  private async createEmbeddingContextsWithFallback(
    targetParallelism: number,
    contextSize: number,
    onProgress?: (progress: EmbeddingModelProgress) => void,
  ): Promise<LlamaEmbeddingContext[]> {
    try {
      return await this.createEmbeddingContexts(targetParallelism, contextSize, onProgress);
    } catch (error) {
      if (!this.canRetryGpuOperationOnCpu()) {
        throw error;
      }

      process.stderr.write(
        `zvec-grep warning: llama.cpp GPU embedding context failed (${formatErrorMessage(error)}), falling back to CPU.\n`,
      );
      this.usingCpuFallback = true;
      await this.disposeLoadedRuntime();
      return await this.createEmbeddingContexts(targetParallelism, contextSize, onProgress);
    }
  }

  private async createEmbeddingContexts(
    targetParallelism: number,
    contextSize: number,
    onProgress?: (progress: EmbeddingModelProgress) => void,
  ): Promise<LlamaEmbeddingContext[]> {
    const model = await this.ensureModel(onProgress);
    this.contextSize = contextSize;
    const threads = await this.resolveThreadsPerContext(targetParallelism);
    const initialContextCount = this.contexts.length;

    while (this.contexts.length < targetParallelism) {
      try {
        const context = await model.createEmbeddingContext({
          contextSize,
          threads,
        });
        if (this.disposed) {
          await context.dispose?.();
          break;
        }
        this.contexts.push(context);
      } catch (error) {
        if (this.contexts.length === initialContextCount) {
          throw error;
        }
        break;
      }
    }

    return this.contexts.slice(0, targetParallelism);
  }

  private canRetryGpuOperationOnCpu(): boolean {
    return this.gpu !== false && !this.usingCpuFallback;
  }

  private shouldDisableModelGpuOffload(): boolean {
    return this.gpu === false || this.usingCpuFallback;
  }

  private async disposeLoadedRuntime(): Promise<void> {
    await this.disposeEmbeddingContexts();

    const model = this.model;
    this.model = null;
    await model?.dispose?.();

    const llama = this.llama;
    this.llama = null;
    if (llama?.dispose) {
      await Promise.race([
        Promise.resolve(llama.dispose()),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }

    this.modelLoadPromise = null;
    this.llamaLoadPromise = null;
  }

  private async resolveModelPath(
    downloadProgress: ModelDownloadProgressReporter,
  ): Promise<string> {
    mkdirSync(this.modelCacheDir, { recursive: true });

    const runtime = await this.loadRuntime();
    const modelPath = await runtime.resolveModelFile(this.entry.uri, {
      directory: this.modelCacheDir,
      cli: false,
      onProgress: ({ downloadedSize, totalSize }) => {
        downloadProgress.report({
          artifact: basename(this.entry.uri),
          downloadedBytes: downloadedSize,
          totalBytes: totalSize,
        });
      },
    });
    validateGgufFile(modelPath, this.entry.uri);
    return modelPath;
  }

  private async resolveEffectiveParallelism(
    textCount: number,
    contextSize: number,
  ): Promise<number> {
    const requested = await this.resolveParallelism(contextSize);
    return Math.max(1, Math.min(requested, Math.max(1, textCount)));
  }

  /**
   * Parallelism is an explicit memory decision. A qwen3 embedding context at the catalog
   * maximum costs over a gigabyte of KV cache, so the number of contexts is derived from a
   * declared byte budget and the real per-context cost of the size actually being created.
   */
  private async resolveParallelism(contextSize: number): Promise<number> {
    if (this.parallelism !== undefined) {
      return this.parallelism;
    }

    const model = await this.ensureModel();
    const perContextBytes = await this.estimateContextResourceCost(
      contextSize,
      model,
    );
    let limit = Math.min(
      DEFAULT_PARALLELISM_CAP,
      Math.floor(this.embeddingContextBudgetBytes / perContextBytes),
    );

    const llama = await this.ensureLlama();
    if (!this.shouldDisableModelGpuOffload() && llama.gpu && llama.getVramState) {
      try {
        const vram = await llama.getVramState();
        limit = Math.min(limit, Math.floor((vram.free * 0.25) / perContextBytes));
      } catch {
        // Free-VRAM reporting is advisory. The declared budget above is the real bound.
      }
    }

    return Math.max(1, limit);
  }

  private async estimateContextResourceCost(
    contextSize: number,
    model: LlamaModel,
  ): Promise<number> {
    const fileInsights = model.fileInsights;
    const estimate = fileInsights?.estimateContextResourceRequirements;
    if (fileInsights && estimate) {
      try {
        const required = await estimate.call(fileInsights, {
          contextSize,
          isEmbeddingContext: true,
          sequences: 1,
        });
        const total = (required?.cpuRam ?? NaN) + (required?.gpuVram ?? NaN);
        if (Number.isFinite(total) && total > 0) {
          return total;
        }
      } catch {
        // Fall through to the measured estimate below.
      }
    }

    // Measured on Qwen3-Embedding-0.6B: a context costs a small fixed allocation plus one
    // KV entry per token (2 x 28 layers x 8 KV heads x 128 dims x 2 bytes = 114,688 B).
    return 18 * 1024 * 1024 + 114688 * contextSize;
  }

  private async resolveThreadsPerContext(parallelism: number): Promise<number> {
    const llama = await this.ensureLlama();
    if (!this.shouldDisableModelGpuOffload() && llama.gpu) {
      return 0;
    }

    const cores = llama.cpuMathCores ?? 4;
    if (parallelism <= 1) {
      return 0;
    }

    return Math.max(1, Math.floor(cores / parallelism));
  }

  private truncateToContextSize(text: string): {
    text: string;
    truncated: boolean;
    tokenCount: number;
  } {
    const model = this.model;
    if (!model?.tokenize || !model.detokenize) {
      // Without a tokenizer the token count is unknowable, so assume the maximum.
      return { text, truncated: false, tokenCount: this.entry.contextSize };
    }

    const limit = Math.max(
      1,
      Math.min(
        this.entry.contextSize,
        model.trainContextSize ?? this.entry.contextSize,
      ),
    );
    const tokens = model.tokenize(text);
    if (tokens.length <= limit) {
      return { text, truncated: false, tokenCount: tokens.length };
    }

    const limited = tokens.slice(0, Math.max(1, limit - 4));
    return {
      text: model.detokenize(limited),
      truncated: true,
      tokenCount: limited.length,
    };
  }

  /**
   * The catalog `contextSize` is the maximum this model supports, not the size every batch
   * has to pay for. Embeddings depend only on the token sequence, so any context at least as
   * large as the longest input produces identical vectors; the margin covers the BOS/EOS
   * tokens the embedding context adds.
   */
  private requiredContextSize(maxTokens: number): number {
    if (this.entry.contextSize < EMBEDDING_CONTEXT_BUCKETS[0]) {
      return this.entry.contextSize;
    }

    const needed = maxTokens + 8;
    const bucket = EMBEDDING_CONTEXT_BUCKETS.find((size) => size >= needed);
    return Math.min(this.entry.contextSize, bucket ?? this.entry.contextSize);
  }

  private async disposeEmbeddingContexts(): Promise<void> {
    const contexts = this.contexts;
    this.contexts = [];
    this.contextSize = null;
    await Promise.all(contexts.map((context) => context.dispose?.()));
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new EngineError("llama.cpp embedding model is disposed", {
        code: "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_DISPOSED",
        context: `model=${this.entry.reference}`,
      });
    }
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportLlamaWarning(
  downloadProgress: ModelDownloadProgressReporter | undefined,
  message: string,
): void {
  if (!downloadProgress?.warning(message)) {
    process.stderr.write(`zvec-grep warning: ${message}\n`);
  }
}

function llamaCppLogger(_level: unknown, message: string): void {
  const trimmed = message.trim();
  if (SUPPRESSED_LLAMA_CPP_LOG_MESSAGES.has(trimmed)) {
    return;
  }

  process.stderr.write(formatLlamaCppLogMessage(message));
}

function formatLlamaCppLogMessage(message: string): string {
  const text = message.trimEnd();
  if (!text) {
    return "";
  }

  return `${text
    .split("\n")
    .map((line) => `[node-llama-cpp] ${line}`)
    .join("\n")}\n`;
}

function defaultLlamaCppCmakeOptions(): Record<string, string> | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  // macOS machines commonly lack libomp, and Apple Clang's native ARM flag
  // probe emits a scary CMake warning despite falling back successfully.
  if (process.arch === "arm64") {
    return { ...DEFAULT_DARWIN_ARM64_CMAKE_OPTIONS };
  }

  return { ...DEFAULT_DARWIN_CMAKE_OPTIONS };
}

function formatTextForEmbedding(
  text: string,
  purpose: NormalizedEmbeddingOptions["purpose"],
  entry: LlamaCppEmbeddingCatalogEntry,
): string {
  if (entry.format === "qwen3") {
    return purpose === "query"
      ? `Instruct: Retrieve relevant documents for the given query\nQuery: ${text}`
      : text;
  }

  return purpose === "query"
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
}

function embeddingDeviceToLlamaGpuSelection(
  device: NonNullable<CreateEmbeddingModelOptions["device"]>,
): LlamaGpuSelection {
  return device === "cpu" ? false : device;
}

function resolveParallelismOverride(
  envValue: string | undefined,
): number | undefined {
  const normalized = envValue?.trim() ?? "";
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write(
      `zvec-grep warning: invalid ZVEC_GREP_LLAMA_CONTEXT_PARALLELISM="${envValue}", using automatic parallelism.\n`,
    );
    return undefined;
  }

  return Math.min(DEFAULT_PARALLELISM_CAP, parsed);
}

function resolveEmbeddingContextBudget(optionValue: number | undefined, envValue: string | undefined): number {
  const fallback = optionValue !== undefined && Number.isFinite(optionValue) && optionValue > 0 ? optionValue : DEFAULT_EMBEDDING_CONTEXT_BUDGET_BYTES;
  const normalized = envValue?.trim() ?? "";
  if (!normalized) return fallback;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write('zvec-grep warning: invalid ZVEC_GREP_EMBEDDING_CONTEXT_BUDGET_MB="' + envValue + '", using the configured default.\n');
    return fallback;
  }
  return parsed * 1024 * 1024;
}

function validateGgufFile(filePath: string, modelUri: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const fd = openSync(filePath, "r");
  const sniff = Buffer.alloc(512);
  try {
    readSync(fd, sniff, 0, 512, 0);
  } finally {
    closeSync(fd);
  }

  const header = sniff.subarray(0, 4);
  if (header.equals(GGUF_MAGIC)) {
    return;
  }

  const text = sniff.toString("utf8").toLowerCase();
  const isHtml = text.includes("<!doctype") || text.includes("<html");
  const got = header.toString("utf8");
  const sizeKb = existsSync(filePath)
    ? (statSync(filePath).size / 1024).toFixed(0)
    : "0";

  unlinkSync(filePath);

  if (isHtml) {
    throw new EngineError(
      "Downloaded local embedding model is HTML, not GGUF",
      {
        code: "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_INVALID_GGUF_HTML",
        context: `model=${modelUri} path=${filePath} sizeKB=${sizeKb}`,
      },
    );
  }

  throw new EngineError("Local embedding model is not a valid GGUF file", {
    code: "ZVEC_GREP.ENGINE.MODELS.LLAMA_CPP_INVALID_GGUF",
    context: `model=${modelUri} path=${filePath} expected=GGUF actual=${got} sizeKB=${sizeKb}`,
  });
}
