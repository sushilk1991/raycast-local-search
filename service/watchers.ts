import { Worker } from "node:worker_threads";

export interface FolderWatch {
  ready: Promise<void>;
  close(): void;
}

// Folder permission prompts can block fs.watch's open(). Keep that syscall off the HTTP host thread.
// host -> workerData roots -> watcher thread -> change/error messages -> reconciliation queue
const WATCH_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const { watch } = require("node:fs");
for (const root of workerData) {
  try {
    const watcher = watch(root, { recursive: true }, () => parentPort.postMessage({ type: "change" }));
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
): FolderWatch {
  if (roots.length === 0) {
    return { ready: Promise.resolve(), close() {} };
  }
  const worker = new Worker(WATCH_SOURCE, { eval: true, workerData: roots });
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
