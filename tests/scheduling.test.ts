import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  open,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Controller, Timing } from "../service/controller";
import { paths } from "../service/paths";
import { DEFAULT_CONFIG } from "../service/protocol";
import { IGNORED_FOLDER_NAMES } from "../service/ignored";
import { watchFolders } from "../service/watchers";

const MODEL_BYTES = [
  ["embeddinggemma-2-Q8_0.gguf", 309855456],
  ["mmproj-embeddinggemma-2-Q8_0.gguf", 554821024],
] as const;
const WAIT_MS = 6000;
// Fast housekeeping, and a safety rescan that cannot fall inside a test: only a change or a retry starts a crawl.
const QUIET: Partial<Timing> = {
  tickMs: 20,
  debounceMs: 20,
  rescanMs: 3600000,
  unwatchedRescanMs: 3600000,
};

// A synthetic engine appends one line per index run; its body decides what the run reports.
async function fixture(body: string, timing: Partial<Timing>, models = true) {
  const root = await mkdtemp(join(tmpdir(), "ls-schedule-"));
  const locations = paths(join(root, "state"));
  const content = join(root, "docs");
  const runs = join(root, "runs");
  await mkdir(content);
  await mkdir(join(locations.base, "bin"), { recursive: true });
  await mkdir(locations.models);
  const installModels = async () => {
    for (const [name, bytes] of MODEL_BYTES) {
      const file = await open(join(locations.models, name), "w");
      await file.truncate(bytes);
      await file.close();
    }
  };
  if (models) {
    await installModels();
  }
  await writeFile(
    locations.engine,
    `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='resources'){console.log(JSON.stringify({lowPowerMode:false}))}else{fs.appendFileSync(${JSON.stringify(runs)},Date.now()+'\\n');${body}}\n`,
  );
  await chmod(locations.engine, 0o755);
  const controller = new Controller(locations, async () => undefined, timing);
  await controller.initialize();
  await controller.configure({ ...DEFAULT_CONFIG, roots: [content] });
  const starts = async () =>
    (await readFile(runs, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map(Number);
  const cleanup = async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  };
  return { controller, content, starts, cleanup, installModels };
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

const SYNC = (ms: number) =>
  `console.log(JSON.stringify({event:'sync',ms:${ms},files:1,searchable:1,pending:0,vectors:1}))`;

// The defect this guards: a timer that marked the index dirty every minute walked every folder around the clock.
test("an unchanged folder is crawled once, however often the timer ticks", async () => {
  const { starts, cleanup } = await fixture(SYNC(1), QUIET);
  try {
    await waitFor(async () => (await starts()).length === 1, "first crawl");
    await delay(500); // 25 ticks
    assert.equal((await starts()).length, 1);
  } finally {
    await cleanup();
  }
});

test("a change in a watched folder starts one crawl", async () => {
  const { content, starts, cleanup } = await fixture(SYNC(1), QUIET);
  try {
    await waitFor(async () => (await starts()).length === 1, "first crawl");
    await delay(300); // watcher startup
    await writeFile(join(content, "new.txt"), "synthetic");
    await waitFor(async () => (await starts()).length === 2, "second crawl");
    await delay(500);
    assert.equal((await starts()).length, 2);
  } finally {
    await cleanup();
  }
});

test("a slow crawl earns a rest before the next one", async () => {
  // The walk reports 80 ms; ten times that must pass before another starts, whatever changes meanwhile.
  const { content, starts, cleanup } = await fixture(SYNC(80), {
    ...QUIET,
    restFactor: 10,
  });
  try {
    await waitFor(async () => (await starts()).length === 1, "first crawl");
    await delay(300);
    await writeFile(join(content, "new.txt"), "synthetic");
    await waitFor(async () => (await starts()).length === 2, "second crawl");
    const [first, second] = await starts();
    assert.ok(second - first >= 800, `rested only ${second - first} ms`);
  } finally {
    await cleanup();
  }
});

test("a rescan the user asks for does not wait out the rest", async () => {
  const { controller, starts, cleanup } = await fixture(SYNC(600000), QUIET);
  try {
    await waitFor(async () => (await starts()).length === 1, "first crawl");
    await delay(300);
    assert.equal((await starts()).length, 1);
    controller.rescan();
    await waitFor(async () => (await starts()).length === 2, "requested crawl");
  } finally {
    await cleanup();
  }
});

test("the longest rest is capped", async () => {
  const { content, starts, cleanup } = await fixture(SYNC(600000), {
    ...QUIET,
    maxRestMs: 400,
  });
  try {
    await waitFor(async () => (await starts()).length === 1, "first crawl");
    await delay(300);
    await writeFile(join(content, "new.txt"), "synthetic");
    await waitFor(async () => (await starts()).length === 2, "second crawl");
  } finally {
    await cleanup();
  }
});

test("a failing worker is retried, each time after a longer pause", async () => {
  const { starts, cleanup, controller } = await fixture("process.exit(1)", {
    ...QUIET,
    retryMs: 100,
    maxRetryMs: 100000,
  });
  try {
    // Pauses of 100, 200, 400 ms: the fourth run starts no sooner than 700 ms after the first.
    await waitFor(async () => (await starts()).length >= 4, "three retries");
    const runs = await starts();
    assert.ok(
      runs[3] - runs[0] >= 700,
      `retried within ${runs[3] - runs[0]} ms`,
    );
    assert.ok(runs[2] - runs[1] >= 190);
    // Each new run clears the previous error until it fails in turn: wait for one to be reported.
    await waitFor(
      async () =>
        /stopped|worker/i.test((await controller.status()).error ?? ""),
      "the failure to be reported",
    );
  } finally {
    await cleanup();
  }
});

test("a run that made progress before failing is retried without escalation", async () => {
  const file = `console.log(JSON.stringify({event:'file',done:1,total:9,path:'/synthetic.txt'}))`;
  const { starts, cleanup } = await fixture(`${file};process.exit(1)`, {
    ...QUIET,
    retryMs: 100,
    maxRetryMs: 100000,
  });
  try {
    // A time budget that ran out mid-backfill is this case: go on after the base pause, every time.
    await waitFor(async () => (await starts()).length >= 5, "four retries");
    const runs = await starts();
    assert.ok(runs[4] - runs[0] < 1500, `escalated: ${runs[4] - runs[0]} ms`);
  } finally {
    await cleanup();
  }
});

// The engine reports a dead model or a failed sync as an event and exits 0: that must not look like "all done".
test("a run that reported a native error is retried", async () => {
  const { starts, cleanup, controller } = await fixture(
    `${SYNC(0)};console.log(JSON.stringify({event:'error',message:'context allocation failed',fatal:true}))`,
    { ...QUIET, retryMs: 100, maxRetryMs: 100000 },
  );
  try {
    await waitFor(async () => (await starts()).length >= 3, "two retries");
    await waitFor(
      async () =>
        /context allocation failed/.test(
          (await controller.status()).error ?? "",
        ),
      "the native error to be reported",
    );
  } finally {
    await cleanup();
  }
});

test("indexing starts once the model arrives, without a change", async () => {
  const { starts, cleanup, installModels, controller } = await fixture(
    SYNC(1),
    QUIET,
    false,
  );
  try {
    await waitFor(
      async () =>
        (await controller.status()).activity === "waiting: model download",
      "model wait",
    );
    assert.equal((await starts()).length, 0);
    await installModels();
    await waitFor(async () => (await starts()).length === 1, "first crawl");
  } finally {
    await cleanup();
  }
});

test("the safety rescan runs when its interval has passed", async () => {
  const { starts, cleanup } = await fixture(SYNC(1), {
    ...QUIET,
    rescanMs: 300,
  });
  try {
    await waitFor(async () => (await starts()).length >= 3, "two rescans");
    const runs = await starts();
    assert.ok(runs[1] - runs[0] >= 290);
  } finally {
    await cleanup();
  }
});

// What the crawler never walks cannot change the index: an install or a build must not start a crawl.
test("changes the crawler would not see do not reach the service", async () => {
  const root = await mkdtemp(join(tmpdir(), "ls-ignored-"));
  const excluded = join(root, "Archive");
  for (const folder of [
    "node_modules/pkg",
    ".git",
    "Caches",
    "x.noindex",
    "Archive/old",
    "docs",
  ]) {
    await mkdir(join(root, folder), { recursive: true });
  }
  let changes = 0;
  const errors: string[] = [];
  const watcher = watchFolders(
    [root],
    () => {
      changes += 1;
    },
    (error) => errors.push(error),
    [excluded],
  );
  try {
    await watcher.ready;
    await delay(300);
    for (const file of [
      "node_modules/pkg/index.md",
      ".git/index",
      "Caches/blob.txt",
      "x.noindex/a.txt",
      "Archive/old/a.txt",
      ".DS_Store",
    ]) {
      await writeFile(join(root, file), "synthetic");
    }
    await delay(800);
    assert.equal(changes, 0);
    // A burst of real changes is reported in a few messages, not one per file (how many depends on how the
    // writes fall across the coalescing window).
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(root, "docs", `note-${index}.txt`), "synthetic"),
      ),
    );
    await delay(800);
    assert.ok(changes >= 1 && changes <= 4, `${changes} notifications`);
    // The marker that takes a folder out of the index is hidden, and still counts.
    const before = changes;
    await writeFile(join(root, "docs", ".metadata_never_index"), "");
    await delay(800);
    assert.equal(changes, before + 1);
    assert.deepEqual(errors, []);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

// The watcher and the native crawler must agree on what is never walked.
test("the watcher ignores exactly the folders the crawler skips", async () => {
  const rules = await readFile("native/Sources/DigUpKit/Rules.swift", "utf8");
  const names = ["skippedFolderNames", "cacheFolderNames"].flatMap((list) => {
    const start = rules.indexOf(`static let ${list}: Set<String> = [`);
    assert.ok(start >= 0, list);
    const literal = rules.slice(start, rules.indexOf("]", start));
    return [...literal.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
      (match) => match[1],
    );
  });
  assert.deepEqual([...names].sort(), [...IGNORED_FOLDER_NAMES].sort());
});
