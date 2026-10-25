import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { paths } from "../service/paths";
import {
  removeService,
  installationState,
  restartService,
} from "../service/install";
import { HELPER_VERSION, MODELS } from "../service/artifacts";

// These files model the installed artifact contract; sparse models avoid fixture downloads.
async function cachedHelper() {
  const base = await fs.mkdtemp(join(tmpdir(), "ls-recovery-"));
  const locations = paths(base);
  await fs.mkdir(join(base, "bin"));
  await fs.mkdir(locations.models);
  for (const name of ["node", "local-search-engine", "service.cjs"]) {
    await fs.writeFile(join(base, "bin", name), "fixture", { mode: 0o700 });
  }
  for (const model of MODELS) {
    const file = await fs.open(join(locations.models, model.name), "w");
    await file.truncate(model.bytes);
    await file.close();
  }
  await fs.writeFile(join(base, "installed-version"), HELPER_VERSION);
  return locations;
}

test("abandoned empty or partial setup locks do not block removal", async () => {
  for (const contents of ["", "1", "partial-pid"]) {
    const base = await fs.mkdtemp(join(tmpdir(), "ls-empty-lock-"));
    await fs.writeFile(join(base, "install.lock"), contents);
    await removeService(paths(base), join(base, "agents"), async () => {});
    await fs.access(join(base, "disabled"));
  }
});

// Kill an actual lock owner: the next process must recover without interpreting or unlinking its file.
test(
  "a crashed setup process releases its kernel lock",
  { timeout: 10000 },
  async (t) => {
    const base = await fs.mkdtemp(join(tmpdir(), "ls-owner-crash-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
    const { removeService } = require(process.argv[3]);
    const { paths } = require(process.argv[4]);
    removeService(paths(process.argv[1]), process.argv[2], async (_file, args) => {
      if (args[0] === "print") {
        process.stdout.write("locked\\n");
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `,
        base,
        join(base, "agents"),
        resolve("service/install.ts"),
        resolve("service/paths.ts"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    await new Promise<void>((done, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("locked\n")) {
          done();
        }
      });
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("Owner exited before obtaining the lock")),
      );
    });
    await assert.rejects(
      removeService(paths(base), join(base, "agents"), async () => {}),
      /already running/,
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    await removeService(paths(base), join(base, "agents"), async () => {});
    await fs.access(join(base, "disabled"));
  },
);

test(
  "stale-lock recovery never admits two setup owners",
  { timeout: 5000 },
  async (t) => {
    const base = await fs.mkdtemp(join(tmpdir(), "ls-stale-lock-"));
    const lock = join(base, "install.lock");
    await fs.writeFile(lock, "99999999");
    let openReads!: () => void;
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    let releaseBody!: () => void;
    const readGate = new Promise<void>((done) => {
      openReads = done;
    });
    const firstEntered = new Promise<void>((done) => {
      enteredFirst = done;
    });
    const secondEntered = new Promise<void>((done) => {
      enteredSecond = done;
    });
    const bodyGate = new Promise<void>((done) => {
      releaseBody = done;
    });
    const read = fs.readFile;
    const unlink = fs.unlink;
    let reads = 0,
      unlinks = 0,
      owners = 0;

    // Reproduce the old race: both read the dead PID, then the second unlink waits for a new owner.
    t.mock.method(
      fs,
      "readFile",
      async (...args: Parameters<typeof fs.readFile>) => {
        const result = await read(...args);
        if (args[0] === lock) {
          reads += 1;
          if (reads === 2) {
            openReads();
          }
          await readGate;
        }
        return result;
      },
    );
    t.mock.method(
      fs,
      "unlink",
      async (path: Parameters<typeof fs.unlink>[0]) => {
        if (path === lock && ++unlinks === 2) {
          await firstEntered;
        }
        return unlink(path);
      },
    );
    const run = async (_file: string, args: string[]) => {
      if (args[0] !== "print") {
        return;
      }
      owners += 1;
      enteredFirst();
      if (owners === 2) {
        enteredSecond();
      }
      await bodyGate;
    };
    const first = removeService(paths(base), join(base, "agents"), run).then(
      () => "ok",
      () => "rejected",
    );
    const second = removeService(paths(base), join(base, "agents"), run).then(
      () => "ok",
      () => "rejected",
    );
    try {
      await Promise.race([first, second, secondEntered]);
      await firstEntered;
      assert.equal(owners, 1, "only one command may reach launchd");
    } finally {
      releaseBody();
      await Promise.all([first, second]);
    }
  },
);

test("an intact stopped service restarts without network or configuration changes", async (t) => {
  const locations = await cachedHelper();
  await fs.writeFile(locations.config, "saved user settings");
  assert.equal(await installationState(locations), "stopped");
  let network = 0;
  t.mock.method(globalThis, "fetch", async () => {
    network += 1;
    throw new Error("offline");
  });
  const calls: string[][] = [];
  await restartService(
    () => {},
    locations,
    join(locations.base, "agents"),
    async (file, args) => {
      calls.push([file, ...args]);
    },
    async () => {},
  );
  assert.equal(network, 0);
  assert.ok(calls.some((call) => call.includes("bootstrap")));
  assert.equal(
    await fs.readFile(locations.config, "utf8"),
    "saved user settings",
  );
  assert.equal(
    await installationState(locations),
    "stopped",
    "state reflects socket health, not restart intent",
  );
});

test("missing models need setup and explicit removal forbids restart", async () => {
  const locations = await cachedHelper();
  await fs.unlink(join(locations.models, MODELS[0].name));
  assert.equal(await installationState(locations), "missing");
  await fs.writeFile(join(locations.base, "disabled"), "removed");
  assert.equal(await installationState(locations), "disabled");
  await assert.rejects(
    restartService(
      () => {},
      locations,
      join(locations.base, "agents"),
      async () => {},
      async () => {},
    ),
    /removed/i,
  );
});
