import {
  access,
  copyFile,
  readFile,
  realpath,
  readdir,
  writeFile,
  rename,
  mkdir,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { watchFolders, FolderWatch } from "./watchers";
import { join } from "node:path";
import { Paths } from "./paths";
import { selectedPath } from "./selection";
import { readResourceBlock, ResourceBlock } from "./resources";
import {
  Config,
  CONFIG_CONFLICT,
  DEFAULT_CONFIG,
  Hit,
  Status,
  PROTOCOL_VERSION,
  validateConfig,
  decodeHits,
} from "./protocol";
import {
  startWorker,
  WorkerRun,
  WorkerKind,
  SEARCH_TIMEOUT_MS,
  INDEX_TIMEOUT_MS,
} from "./worker";

// Indexing and query inference share one native-worker slot:
// watchers -> dirty flag -> index worker <-- yields to <-- search request.
const POWER_POLL_MS = 10000;
const QUERY_IDLE_MS = 10000;

// When a crawl may start. Every index worker begins by walking all chosen folders, so starting one is never free:
// a walk each minute "to be safe" kept a synced folder's file provider busy around the clock. Watchers say when
// something changed; the timer covers only what they cannot see, and a slow walk earns a proportionally long rest.
export interface Timing {
  /** Housekeeping: is the model here yet, did a drive come back, is a safety rescan due. Starts no crawl itself. */
  tickMs: number;
  /** Quiet time after a change before crawling. */
  debounceMs: number;
  /** Safety rescan while every chosen folder is watched. */
  rescanMs: number;
  /** Rescan while a folder cannot be watched. */
  unwatchedRescanMs: number;
  /** Rest this many times the last crawl's duration before the next one (10: crawling at most 1/11 of the time). */
  restFactor: number;
  maxRestMs: number;
  /** First retry after a worker failed; doubles while runs keep failing without getting anything done. */
  retryMs: number;
  maxRetryMs: number;
}

export const DEFAULT_TIMING: Timing = {
  tickMs: 60 * 1000,
  debounceMs: 2000,
  rescanMs: 6 * 60 * 60 * 1000,
  unwatchedRescanMs: 15 * 60 * 1000,
  restFactor: 10,
  maxRestMs: 30 * 60 * 1000,
  retryMs: 60 * 1000,
  maxRetryMs: 30 * 60 * 1000,
};
const CACHE_LIMIT = 64;
const COUNT_EVENTS = ["sync", "waiting", "idle"];
const COUNT_FIELDS = ["files", "searchable", "pending", "vectors"];
const PRUNE_TIMEOUT_MS = 30000;
// A two-standard-deviation gate hides valid semantic matches in tiny indexes (including a single document).
const MIN_SEMANTIC_Z = "0";
const TEXT_MODEL = "embeddinggemma-2-Q8_0.gguf";
const MEDIA_MODEL = "mmproj-embeddinggemma-2-Q8_0.gguf";

export class Controller {
  private config: Config = structuredClone(DEFAULT_CONFIG);
  private activity = "idle";
  private progress: Status["progress"];
  private counts: Status["counts"];
  private missingRoots: string[] = [];
  private error: string | undefined;
  private worker: WorkerRun | undefined;
  private watcher: FolderWatch | undefined;
  private reconcile: NodeJS.Timeout | undefined;
  private powerTimer: NodeJS.Timeout | undefined;
  private scheduled: NodeJS.Timeout | undefined;
  private dirty = true;
  private querying = false;
  private closed = false;
  private configFailed = false;
  private configEpoch = 0;
  private clearPending = false;
  private clearing = false;
  private readonly stoppedWorkers = new WeakSet<WorkerRun>();
  private blocked: string | undefined;
  private cache = new Map<string, Hit[]>();
  private configQueue: Promise<unknown> = Promise.resolve();
  private readonly timing: Timing;
  // Crawl pacing: when the last walk finished, how long to stay away, and what the watchers cannot vouch for.
  private lastCrawlAt = 0;
  private restUntil = 0;
  private failures = 0;
  private progressed = false;
  private nativeError = false;
  private watchFailed = false;
  private ticking = false;
  private readonly returnedRoots = new Set<string>();

  constructor(
    private readonly locations: Paths,
    private readonly resourceCheck = readResourceBlock,
    timing: Partial<Timing> = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  async initialize(): Promise<void> {
    await mkdir(this.locations.index, { recursive: true, mode: 0o700 });
    // Keep native temporary-file cleanup inside our own state, never another app's system temp folders.
    await mkdir(this.locations.scratch, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.locations.config, "utf8"));
      this.config = validateConfig(saved);
      // Cleanup intent is committed atomically with empty roots and survives interruption or restart.
      this.clearPending =
        saved.clearPending === true && this.config.roots.length === 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.config.paused = true;
        this.configFailed = true;
        this.error = `Configuration could not be read; indexing paused: ${String(error)}`;
      }
    }
    await this.refreshPower();
    this.resetWatchers();
    this.reconcile = setInterval(() => {
      void this.tick();
    }, this.timing.tickMs);
    this.powerTimer = setInterval(() => {
      void this.refreshPower();
    }, POWER_POLL_MS);
    this.schedule();
  }

  async status(): Promise<Status> {
    return {
      version: PROTOCOL_VERSION,
      config: structuredClone(this.config),
      activity: this.config.paused ? "paused" : (this.blocked ?? this.activity),
      progress: this.progress,
      counts: this.counts,
      missingRoots: [...this.missingRoots],
      error: this.error,
      modelReady: await this.modelsReady(),
    };
  }

  async configure(value: unknown, expectedValue?: unknown): Promise<void> {
    // Serialize writes and compare UI snapshots inside the queue so stale controls cannot restore old folders.
    const next = validateConfig(value);
    const expected =
      expectedValue === undefined ? undefined : validateConfig(expectedValue);
    const update = this.configQueue.then(async () => {
      this.assertRunning();
      if (this.configFailed && next.roots.length === 0) {
        throw new Error(
          "Saved configuration is unavailable; restore it or choose folders explicitly before changing controls",
        );
      }
      if (
        expected &&
        JSON.stringify(expected) !== JSON.stringify(this.config)
      ) {
        const conflict = new Error(
          "Configuration changed; reopen Choose Folders and Limits and reapply your edits",
        );
        conflict.name = CONFIG_CONFLICT;
        throw conflict;
      }
      // Invalidate queries still checking readiness or yielding an old worker before changing scope.
      this.configEpoch += 1;
      const roots: string[] = [];
      for (const root of next.roots) {
        try {
          const resolved = await realpath(root);
          await readdir(resolved);
          roots.push(resolved);
        } catch (error) {
          // Existing disconnected/unreadable roots stay selected; control changes must still work.
          if (!this.config.roots.includes(root)) {
            throw error;
          }
          roots.push(root);
        }
      }
      next.roots = validateConfig({ ...next, roots }).roots;
      next.excludedFolders = await Promise.all(
        next.excludedFolders.map((folder) =>
          realpath(folder).catch(() => folder),
        ),
      );
      this.assertRunning();
      // Preserve unreadable saved settings before an explicit recovery replaces them.
      if (this.configFailed) {
        await copyFile(
          this.locations.config,
          `${this.locations.config}.invalid-${Date.now()}`,
          constants.COPYFILE_EXCL,
        );
      }
      this.assertRunning();
      this.clearPending =
        next.roots.length === 0 &&
        (this.clearPending || this.config.roots.length > 0);
      await this.saveConfig(next);
      this.config = next;
      this.configFailed = false;
      await this.stopWorker();
      this.assertRunning();
      // Cleanup is not inference; failures leave a durable retry rather than pretending the settings were not saved.
      if (this.clearPending) {
        try {
          await this.clearIndex();
          this.clearPending = false;
          await this.saveConfig(next);
        } catch (error) {
          this.clearPending = true;
          this.error = `Folder settings saved; index cleanup pending: ${String(error)}`;
        }
      }
      this.assertRunning();
      this.resetWatchers();
      this.cache.clear();
      // The user changed something: don't make them wait out a rest earned by the previous settings.
      this.restUntil = 0;
      this.failures = 0;
      this.markDirty();
      await this.refreshPower();
    });
    this.configQueue = update.catch(() => {});
    return update;
  }

  async search(query: string, signal: AbortSignal): Promise<Hit[]> {
    if (this.querying) {
      throw new Error("A search is already running; try again shortly");
    }
    // Reserve the query slot before asynchronous readiness checks; concurrent requests must not kill each other.
    this.querying = true;
    let queryWorker: WorkerRun | undefined;
    try {
      await this.configQueue;
      this.assertSearchAllowed();
      const epoch = this.configEpoch;
      const ready = await this.modelsReady();
      // Readiness checks yield; shutdown, scope changes or memory pressure may arrive before they finish.
      this.assertSearchAllowed(epoch);
      if (!ready) {
        throw new Error(
          "EmbeddingGemma 2 is not installed. Open Install Local Content Search to repair setup",
        );
      }
      if (this.config.roots.length === 0) {
        throw new Error("Choose a folder in Manage Content Index first");
      }
      const cached = this.cache.get(query);
      if (cached) {
        return cached;
      }
      await this.stopWorker();
      this.assertSearchAllowed(epoch);
      if (signal.aborted) {
        throw new Error("Search cancelled");
      }
      this.activity = "searching";
      // A leading space makes even '--reindex' a positional value in the inherited parser.
      this.worker = startWorker(
        this.locations.engine,
        [
          "search",
          ` ${query}`,
          "--main-index",
          "--index",
          this.locations.index,
          "--json",
          "-n",
          "50",
          "--zgate",
          MIN_SEMANTIC_Z,
          ...this.config.roots.flatMap((root) => ["--root", root]),
          ...this.config.excludedFolders.flatMap((folder) => [
            "--exclude",
            folder,
          ]),
          ...this.config.excludedExtensions.flatMap((extension) => [
            "--exclude-ext",
            extension,
          ]),
        ],
        {
          models: this.locations.models,
          scratch: this.locations.scratch,
          memoryLimitMb: this.config.memoryLimitMb,
          timeoutMs: SEARCH_TIMEOUT_MS,
          signal,
        },
      );
      queryWorker = this.worker;
      const rows = decodeHits(await queryWorker.done);
      // Removed or excluded folders must stop appearing immediately, before the next prune pass.
      const hits = rows.filter((hit) => selectedPath(this.config, hit.path));
      if (this.cache.size >= CACHE_LIMIT) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(query, hits);
      return hits;
    } finally {
      if (queryWorker && this.worker === queryWorker) {
        this.worker = undefined;
        this.activity = "idle";
      }
      this.querying = false;
      this.schedule(QUERY_IDLE_MS);
    }
  }

  markDirty(): void {
    this.dirty = true;
    this.cache.clear();
    this.schedule();
  }

  // The user asked for a scan now: don't make them wait out a rest or a retry pause.
  rescan(): void {
    this.restUntil = 0;
    this.failures = 0;
    this.markDirty();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconcile) {
      clearInterval(this.reconcile);
    }
    if (this.powerTimer) {
      clearInterval(this.powerTimer);
    }
    if (this.scheduled) {
      clearTimeout(this.scheduled);
    }
    this.watcher?.close();
    await this.stopWorker();
    // Drain writes already in flight; their late guards prevent new workers/watchers after shutdown.
    await this.configQueue;
    await this.stopWorker();
  }

  private assertRunning(): void {
    if (this.closed) {
      throw new Error("Service is stopping");
    }
  }

  // Persist private cleanup intent alongside the public config using the same atomic rename.
  private async saveConfig(config: Config): Promise<void> {
    await writeFile(
      `${this.locations.config}.tmp`,
      JSON.stringify({ ...config, clearPending: this.clearPending }, null, 2),
      { mode: 0o600 },
    );
    await rename(`${this.locations.config}.tmp`, this.locations.config);
  }

  // Recheck at every async query boundary so shutdown cannot leave an orphan inference worker.
  private assertSearchAllowed(epoch?: number): void {
    this.assertRunning();
    if (epoch !== undefined && epoch !== this.configEpoch) {
      throw new Error(
        "Configuration changed during search; retry with the current folders",
      );
    }
    if (this.blocked === ResourceBlock.Memory) {
      throw new Error(
        "Search paused because macOS reports high memory pressure; close another app and retry",
      );
    }
  }

  private async modelsReady(): Promise<boolean> {
    try {
      const [text, media] = await Promise.all([
        stat(join(this.locations.models, TEXT_MODEL)),
        stat(join(this.locations.models, MEDIA_MODEL)),
      ]);
      return text.size === 309855456 && media.size === 554821024;
    } catch {
      return false;
    }
  }

  private schedule(delay = this.timing.debounceMs): void {
    if (this.closed) {
      return;
    }
    if (this.scheduled) {
      clearTimeout(this.scheduled);
    }
    // Never sooner than the rest the last crawl (or failure) earned, however many changes arrive.
    const wait = Math.max(delay, this.restUntil - Date.now());
    this.scheduled = setTimeout(() => {
      void this.index().catch((error) => {
        this.error = String(error);
        this.activity = "error";
      });
    }, wait);
  }

  // Timer housekeeping. It asks for a crawl only when something may have changed unseen:
  // waiting work (model, power) -> look again | a missing folder is back | the safety rescan is due.
  private async tick(): Promise<void> {
    if (this.closed || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      if (this.dirty) {
        this.schedule();
        return;
      }
      if (this.config.paused || this.config.roots.length === 0) {
        return;
      }
      if (await this.rootReturned()) {
        this.resetWatchers();
        this.markDirty();
        return;
      }
      const rescan = this.watchFailed
        ? this.timing.unwatchedRescanMs
        : this.timing.rescanMs;
      if (!this.worker && Date.now() - this.lastCrawlAt >= rescan) {
        this.markDirty();
      }
    } finally {
      this.ticking = false;
    }
  }

  // A folder the worker reported missing (an unplugged drive) is readable again. Each return counts once: a folder
  // that lists here but stays unreadable to the worker must not turn into a crawl per tick.
  private async rootReturned(): Promise<boolean> {
    let returned = false;
    for (const root of this.missingRoots) {
      const readable = await readdir(root).then(
        () => true,
        () => false,
      );
      if (!readable) {
        this.returnedRoots.delete(root);
      } else if (!this.returnedRoots.has(root)) {
        this.returnedRoots.add(root);
        returned = true;
      }
    }
    return returned;
  }

  private resetWatchers(): void {
    // Watch startup can wait for macOS folder permission; it must not block service readiness or controls.
    this.watcher?.close();
    this.watchFailed = false;
    this.watcher = watchFolders(
      this.config.roots,
      () => {
        this.markDirty();
      },
      (message) => {
        this.watchFailed = true;
        this.error = `Folder watcher: ${message}; periodic rescans remain enabled`;
      },
      this.config.excludedFolders,
    );
  }

  private async clearIndex(): Promise<void> {
    const worker = startWorker(
      this.locations.engine,
      [
        "index-service",
        "--index",
        this.locations.index,
        "--prune",
        "--linger",
        "0",
        "--new-limit",
        "0",
      ],
      {
        kind: WorkerKind.Index,
        models: this.locations.models,
        scratch: this.locations.scratch,
        memoryLimitMb: this.config.memoryLimitMb,
        timeoutMs: PRUNE_TIMEOUT_MS,
        onLine: (line) => {
          this.onEvent(line);
        },
      },
    );
    this.worker = worker;
    this.clearing = true;
    try {
      await worker.done;
      this.counts = { files: 0, searchable: 0, pending: 0, vectors: 0 };
      this.progress = undefined;
      this.missingRoots = [];
      this.error = undefined;
      this.activity = "idle";
    } finally {
      this.clearing = false;
      if (this.worker === worker) {
        this.worker = undefined;
      }
    }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    this.stoppedWorkers.add(worker);
    worker.stop();
    await worker.done.catch(() => {});
    if (this.worker === worker) {
      this.worker = undefined;
    }
    this.dirty = true;
  }

  private async refreshPower(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    try {
      this.blocked = await this.resourceCheck(
        this.locations.engine,
        this.config.powerMode,
      );
      if (
        this.blocked &&
        !this.clearing &&
        (!this.querying || this.blocked === ResourceBlock.Memory)
      ) {
        await this.stopWorker();
      }
      if (!this.blocked) {
        this.schedule();
      }
    } catch {
      this.blocked = ResourceBlock.Unavailable;
    }
  }

  // Queue cleanup without a captured config: a folder save ahead of it can cancel the intent.
  // folder save -> queue -> recheck intent -> prune only if still empty
  private async retryCleanup(): Promise<void> {
    const retry = this.configQueue.then(async () => {
      this.assertRunning();
      if (!this.clearPending || this.config.roots.length !== 0) {
        return;
      }

      await this.stopWorker();
      this.assertRunning();
      try {
        await this.clearIndex();
        this.clearPending = false;
        await this.saveConfig(this.config);
      } catch (error) {
        this.clearPending = true;
        this.error = `Folder settings saved; index cleanup pending: ${String(error)}`;
      }
    });
    this.configQueue = retry.catch(() => {});
    await retry;
  }

  private async index(): Promise<void> {
    if (this.closed || this.querying || this.worker || !this.dirty) {
      return;
    }
    // Retry durable privacy cleanup before pause/power/model gates; it never loads an embedding model.
    if (this.clearPending && this.config.roots.length === 0) {
      await this.retryCleanup();
      return;
    }
    if (this.config.paused || this.blocked || this.config.roots.length === 0) {
      return;
    }
    if (!(await this.modelsReady())) {
      this.activity = "waiting: model download";
      return;
    }
    await access(this.locations.engine);
    // A search, pause, or config change may arrive while the filesystem checks above are awaiting.
    if (
      this.closed ||
      this.querying ||
      this.worker ||
      this.config.paused ||
      this.blocked ||
      this.config.roots.length === 0
    ) {
      return;
    }
    this.dirty = false;
    this.error = undefined;
    this.activity = "indexing";
    this.progress = undefined;
    const args = [
      "index-service",
      ...this.config.roots,
      "--index",
      this.locations.index,
      "--backfill",
      "--prune",
      "--linger",
      "0",
      "--new-limit",
      "0",
    ];
    for (const folder of this.config.excludedFolders) {
      args.push("--exclude", folder);
    }
    if (this.config.excludedExtensions.length) {
      args.push("--exclude-ext", this.config.excludedExtensions.join(","));
    }
    this.missingRoots = [];
    this.progressed = false;
    this.nativeError = false;
    const worker = startWorker(this.locations.engine, args, {
      kind: WorkerKind.Index,
      models: this.locations.models,
      scratch: this.locations.scratch,
      memoryLimitMb: this.config.memoryLimitMb,
      timeoutMs: INDEX_TIMEOUT_MS,
      onLine: (line) => {
        this.onEvent(line);
      },
    });
    this.worker = worker;
    try {
      await worker.done;
      // The engine reports a failed sync or a dead model as an event and still exits cleanly.
      if (this.nativeError) {
        this.retryLater();
      } else {
        this.failures = 0;
        // These folders were crawled and are no longer reported missing: their next return counts again.
        for (const root of this.returnedRoots) {
          if (!this.missingRoots.includes(root)) {
            this.returnedRoots.delete(root);
          }
        }
      }
    } catch (error) {
      if (
        !this.stoppedWorkers.has(worker) &&
        !this.querying &&
        !this.config.paused &&
        !this.closed
      ) {
        this.error = String(error);
        this.retryLater();
      }
    } finally {
      this.lastCrawlAt = Date.now();
      if (this.worker === worker) {
        this.worker = undefined;
        this.activity = this.error ? "error" : "idle";
      }
      this.cache.clear();
      if (this.dirty) {
        this.schedule();
      }
    }
  }

  // The worker's queue is still waiting (a time budget ran out, a crash, a failed sync) and nothing else will
  // bring it back: go on after a pause. A run that got nothing done waits twice as long each time, so a folder
  // that cannot be crawled is not hammered.
  private retryLater(): void {
    this.failures = this.progressed ? 0 : this.failures + 1;
    const retry = Math.min(
      this.timing.maxRetryMs,
      this.timing.retryMs * 2 ** Math.max(0, this.failures - 1),
    );
    this.restUntil = Math.max(this.restUntil, Date.now() + retry);
    this.dirty = true;
  }

  private onEvent(line: string): void {
    try {
      const event = JSON.parse(line);
      if (event.event === "sync") {
        // The walk is done; what follows is embedding. Stay away for a multiple of what the walk cost.
        const ms = Number.isFinite(event.ms) && event.ms > 0 ? event.ms : 0;
        this.restUntil =
          Date.now() +
          Math.min(this.timing.maxRestMs, this.timing.restFactor * ms);
      }
      // Progress is a file read, not a walk: a run that only crawls before failing must not retry at full pace.
      if (event.event === "rest") {
        this.progressed = true;
      }
      if (event.event === "file") {
        this.progressed = true;
        this.progress = {
          done: event.done,
          total: event.total,
          path: event.path,
        };
      }
      // Only inventory events contain complete counts; pruned/rest use files for a different quantity.
      if (
        COUNT_EVENTS.includes(event.event) &&
        COUNT_FIELDS.some((field) => event[field] !== undefined)
      ) {
        if (
          !COUNT_FIELDS.every(
            (field) => Number.isSafeInteger(event[field]) && event[field] >= 0,
          )
        ) {
          throw new Error("Invalid native inventory counts");
        }
        this.counts = {
          files: event.files,
          searchable: event.searchable,
          pending: event.pending,
          vectors: event.vectors,
        };
      }
      if (event.event === "missing") {
        this.missingRoots = [
          ...(event.folders ?? []),
          ...(event.unreadable ?? []),
        ];
      }
      if (event.event === "error") {
        this.error = String(event.message);
        this.nativeError = true;
      }
    } catch {
      this.error = "Invalid event from native worker";
    }
  }
}
