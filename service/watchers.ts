import { Worker } from "node:worker_threads";
import { IGNORED_FOLDER_NAMES } from "./ignored";

export interface FolderWatch {
  ready: Promise<void>;
  close(): void;
}

// Folder permission prompts can block fs.watch's open(). Keep that syscall off the HTTP host thread.
// host -> workerData roots -> watcher thread -> change/error messages -> reconciliation queue
//
// The thread drops changes the crawler would not see (hidden names, .noindex folders, package stores, caches and
// excluded folders) and reports a burst of changes once, so an install or a build in a watched folder costs nothing.
const COALESCE_MS = 250;
const WATCH_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const { watch } = require("node:fs");
const ignored = new Set(workerData.ignored);
// A hidden name matters only when it is the marker that takes its folder out of the index (or puts it back).
const relevant = (file) => {
  if (!file) return true;
  const parts = String(file).split("/");
  const name = parts.pop();
  if (parts.some((part) => part.startsWith(".") || part.endsWith(".noindex") || ignored.has(part))) return false;
  return name === ".metadata_never_index" || !(name.startsWith(".") || name.endsWith(".noindex") || ignored.has(name));
};
let queued = false;
const changed = () => {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    parentPort.postMessage({ type: "change" });
  }, workerData.coalesceMs);
};
for (const root of workerData.roots) {
  // A folder the user left out of this root; one chosen inside it has a watcher of its own.
  const skips = workerData.excluded
    .filter((folder) => folder.startsWith(root + "/"))
    .map((folder) => folder.slice(root.length + 1));
  const skipped = (file) => skips.some((skip) => file === skip || String(file).startsWith(skip + "/"));
  try {
    const watcher = watch(root, { recursive: true }, (event, file) => {
      if (relevant(file) && !(file && skipped(file))) changed();
    });
    watcher.on("error", (error) => parentPort.postMessage({ type: "error", message: error.message }));
  } catch (error) {
    parentPort.postMessage({ type: "error", message: String(error) });
  }
}
parentPort.postMessage({ type: "ready" });
`;

export function watchFolders(
  roots: string[],
  changed: () => void,
  failed: (message: string) => void,
  excluded: string[] = [],
): FolderWatch {
  if (roots.length === 0) {
    return { ready: Promise.resolve(), close() {} };
  }
  const worker = new Worker(WATCH_SOURCE, {
    eval: true,
    workerData: {
      roots,
      excluded,
      ignored: IGNORED_FOLDER_NAMES,
      coalesceMs: COALESCE_MS,
    },
  });
  // The socket/timers own host lifetime; a permission-blocked watcher must not prevent shutdown.
  worker.unref();
  let closed = false;
  let settle!: () => void;
  const ready = new Promise<void>((done) => {
    settle = done;
  });
  worker.on("message", (event: { type: string; message?: string }) => {
    if (closed) {
      return;
    }
    if (event.type === "ready") {
      settle();
      return;
    }
    if (event.type === "change") {
      changed();
      return;
    }
    if (event.type === "error") {
      failed(event.message ?? "Unknown watch error");
    }
  });
  worker.on("error", (error) => {
    if (!closed) {
      failed(error.message);
    }
    settle();
  });
  worker.on("exit", (code) => {
    if (!closed && code !== 0) {
      failed(`Watcher stopped with code ${code}`);
    }
    settle();
  });
  return {
    ready,
    close() {
      closed = true;
      settle();
      void worker.terminate().catch(() => {});
    },
  };
}
