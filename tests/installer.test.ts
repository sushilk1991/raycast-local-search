import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  access,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadVerified } from "../service/download";
import { activateHelper, removeService } from "../service/install";
import { paths } from "../service/paths";
import { mkdir } from "node:fs/promises";

// Exercise the actual byte stream and filesystem contract, not implementation text.
const payload = Buffer.from("synthetic release artifact");
const sha256 = createHash("sha256").update(payload).digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "local-search-download-"));
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (req.url === "/missing") {
      res.writeHead(404).end();
      return;
    }
    res.end(payload);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  return {
    directory,
    url: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    close: () => server.close(),
  };
}

// Installation uses an injectable launchd boundary; file replacement and plist generation remain real.
test("activation registers a self-contained helper and removal preserves user data", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-search-activate-"));
  const helper = join(base, "helper");
  await mkdir(join(helper, "bin"), { recursive: true });
  await mkdir(join(helper, "licenses"));
  for (const file of ["node", "local-search-engine", "service.cjs"]) {
    await writeFile(join(helper, "bin", file), "fixture");
  }
  await writeFile(join(helper, "licenses/notice"), "license");
  await writeFile(join(base, "config.json"), "keep settings");
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
  };
  const agents = join(base, "agents");
  await activateHelper(helper, paths(base), agents, run, async () => {});
  const plist = await readFile(
    join(agents, "com.sushil.local-content-search.plist"),
    "utf8",
  );
  assert.ok(plist.includes(join(base, "bin/node")));
  assert.ok(!plist.includes(process.execPath));
  assert.ok(calls.some((call) => call.includes("bootstrap")));
  await removeService(paths(base), agents, run);
  assert.equal(
    await readFile(join(base, "config.json"), "utf8"),
    "keep settings",
  );
  await access(join(base, "disabled"));
  await assert.rejects(
    access(join(agents, "com.sushil.local-content-search.plist")),
  );
});

test("registration retries while launchd finishes removing the previous job", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-search-registration-"));
  const helper = join(base, "helper");
  await mkdir(join(helper, "bin"), { recursive: true });
  await mkdir(join(helper, "licenses"));
  for (const file of ["node", "local-search-engine", "service.cjs"]) {
    await writeFile(join(helper, "bin", file), "fixture");
  }
  let attempts = 0;
  const run = async (_file: string, args: string[]) => {
    if (args[0] === "bootstrap" && ++attempts < 3) {
      throw Object.assign(new Error("launchd removal still in progress"), {
        code: 5,
      });
    }
  };
  await activateHelper(
    helper,
    paths(base),
    join(base, "agents"),
    run,
    async () => {},
  );
  assert.equal(attempts, 3);
});

test("activation readiness failure restores the previous helper", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-search-rollback-"));
  const helper = join(base, "helper");
  await mkdir(join(helper, "bin"), { recursive: true });
  await mkdir(join(helper, "licenses"));
  await mkdir(join(base, "bin"));
  await writeFile(join(base, "bin/node"), "old helper");
  for (const file of ["node", "local-search-engine", "service.cjs"]) {
    await writeFile(join(helper, "bin", file), "new helper");
  }
  await assert.rejects(
    activateHelper(
      helper,
      paths(base),
      join(base, "agents"),
      async () => {},
      async () => {
        throw new Error("not ready");
      },
    ),
    /not ready/,
  );
  assert.equal(await readFile(join(base, "bin/node"), "utf8"), "old helper");
});

test("removal does not report success when launchd cannot be inspected", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-search-removal-error-"));
  await assert.rejects(
    removeService(paths(base), join(base, "agents"), async () => {
      throw new Error("permission denied");
    }),
    /permission denied/,
  );
  await assert.rejects(access(join(base, "disabled")));
});

test("concurrent removal cannot acquire an active installation lock", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-search-lock-"));
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((done) => {
    unblock = done;
  });
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const run = async () => {
    entered();
    await blocked;
  };
  const first = removeService(paths(base), join(base, "agents"), run);
  await started;
  await assert.rejects(
    removeService(paths(base), join(base, "agents"), run),
    /already running/,
  );
  unblock();
  await first;
});

test("failed rollback retains the previous binary for recovery", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-search-recovery-"));
  const helper = join(base, "helper");
  await mkdir(join(helper, "bin"), { recursive: true });
  await mkdir(join(helper, "licenses"));
  await mkdir(join(base, "bin"));
  await writeFile(join(base, "bin/node"), "previous helper");
  for (const file of ["node", "local-search-engine", "service.cjs"]) {
    await writeFile(join(helper, "bin", file), "new helper");
  }
  let stops = 0;
  const run = async (_file: string, args: string[]) => {
    if (args[0] === "bootout" && ++stops > 1) {
      throw new Error("stop failed");
    }
  };
  await assert.rejects(
    activateHelper(helper, paths(base), join(base, "agents"), run, async () => {
      throw new Error("not ready");
    }),
  );
  const recovery = (await readdir(base)).find((name) =>
    name.startsWith("activate-"),
  );
  assert.ok(
    recovery,
    "previous helper must remain available after rollback failure",
  );
  assert.equal(
    await readFile(join(base, recovery, "previous-bin/node"), "utf8"),
    "previous helper",
  );
});

test("verified download installs exact bytes and reuses only a valid cache", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const target = join(f.directory, "helper.tgz");
  const spec = { url: f.url, bytes: payload.length, sha256 };
  await downloadVerified(spec, target, () => {});
  assert.deepEqual(await readFile(target), payload);
  await downloadVerified(spec, target, () => {});
  assert.equal(f.requests(), 1);
  await writeFile(target, "corrupt");
  await downloadVerified(spec, target, () => {});
  assert.equal(f.requests(), 2);
  assert.deepEqual(await readFile(target), payload);
});

test("checksum mismatch never publishes a file and retry succeeds", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const target = join(f.directory, "helper.tgz");
  await assert.rejects(
    downloadVerified(
      { url: f.url, bytes: payload.length, sha256: "0".repeat(64) },
      target,
      () => {},
    ),
    /checksum/i,
  );
  await assert.rejects(access(target));
  assert.deepEqual(await readdir(f.directory), []);
  await downloadVerified(
    { url: f.url, bytes: payload.length, sha256 },
    target,
    () => {},
  );
  assert.deepEqual(await readFile(target), payload);
});

test("HTTP failures and oversized streams leave no installed artifact", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const target = join(f.directory, "helper.tgz");
  await assert.rejects(
    downloadVerified(
      { url: `${f.url}/missing`, bytes: payload.length, sha256 },
      target,
      () => {},
    ),
    /404/,
  );
  await assert.rejects(
    downloadVerified({ url: f.url, bytes: 1, sha256 }, target, () => {}),
    /size/i,
  );
  await assert.rejects(access(target));
  assert.deepEqual(await readdir(f.directory), []);
});
