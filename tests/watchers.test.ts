import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFolders } from "../service/watchers";

// The host must retain its event loop while filesystem watches start on another thread.
test("watch driver delivers filesystem changes and closes independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-search-watch-"));
  let changed!: () => void;
  const change = new Promise<void>((done) => {
    changed = done;
  });
  const errors: string[] = [];
  const watcher = watchFolders([root], changed, (error) => errors.push(error));
  try {
    await watcher.ready;
    await writeFile(join(root, "new.txt"), "synthetic content");
    await Promise.race([
      change,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("No watch event")), 3000).unref();
      }),
    ]);
    assert.deepEqual(errors, []);
  } finally {
    watcher.close();
  }
});

test("unavailable watch roots report errors without preventing host readiness", async () => {
  const errors: string[] = [];
  const watcher = watchFolders(
    ["/no-such-local-search-directory"],
    () => {},
    (error) => errors.push(error),
  );
  try {
    await watcher.ready;
    assert.equal(errors.length, 1);
  } finally {
    watcher.close();
  }
});
