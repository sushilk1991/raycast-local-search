import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { createService } from "../service/server";
import { paths } from "../service/paths";
import { LocalClient } from "../service/client";
import { DEFAULT_CONFIG } from "../service/protocol";
import { AGENT_LABEL } from "../service/agent";
import { homedir } from "node:os";

// Temporarily serve synthetic data on the normal socket; never replace the user's config or index.
const exec = promisify(execFile);
const WAIT_MS = 120000;
async function wait(check: () => Promise<boolean>) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("UI fixture did not become ready");
    }
    await new Promise((done) => {
      setTimeout(done, 250);
    });
  }
}
async function main() {
  const normal = paths();
  const original = await readFile(normal.config, "utf8");
  const root = await mkdtemp("/tmp/local-search-demo-");
  const locations = { ...paths(join(root, "state")), socket: normal.socket };
  const content = join(root, "Sample Documents");
  await mkdir(content);
  await mkdir(join(locations.base, "bin"), { recursive: true });
  await symlink(normal.models, locations.models);
  await symlink(normal.engine, locations.engine);
  await writeFile(
    join(content, "lease.txt"),
    "The rental agreement permits two cats and one dog. A pet deposit is required before moving into the apartment.",
  );
  await writeFile(
    join(content, "recipe.txt"),
    "To bake sourdough bread, mix flour, water, salt, and a fermented starter. Let the dough rise overnight.",
  );
  await writeFile(
    join(content, "travel.txt"),
    "The flight to Tokyo departs Friday. Take the express train from Haneda airport to the hotel.",
  );
  const domain = `gui/${process.getuid!()}`;
  const plist = join(homedir(), "Library/LaunchAgents", `${AGENT_LABEL}.plist`);
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let release!: () => void;
  const finished = new Promise<void>((done) => {
    release = done;
  });
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
  await exec("/bin/launchctl", ["bootout", `${domain}/${AGENT_LABEL}`]);
  try {
    // bootout returns before the old socket is necessarily closed.
    await wait(async () =>
      new LocalClient()
        .status()
        .then(() => false)
        .catch(() => true),
    );
    service = await createService(locations);
    const client = new LocalClient();
    await client.configure({ ...DEFAULT_CONFIG, roots: [content] });
    await wait(async () => (await client.status()).counts?.searchable === 3);
    assert.ok(
      (
        await client.search("restrictions on domestic animals")
      )[0]?.path.endsWith("lease.txt"),
    );
    await writeFile(
      "/tmp/local-search-ui-demo.json",
      JSON.stringify({ pid: process.pid, root, content }),
    );
    console.log(
      "READY: synthetic service active; normal settings and index untouched",
    );
    await finished;
  } finally {
    await service?.close();
    // launchd may still be removing its old job immediately after bootout; retry bootstrap EIO only.
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        await exec("/bin/launchctl", ["bootstrap", domain, plist]);
        break;
      } catch (error) {
        if ((error as { code?: number }).code !== 5 || Date.now() > deadline) {
          throw error;
        }
        await new Promise((done) => {
          setTimeout(done, 250);
        });
      }
    }
    await wait(async () =>
      new LocalClient()
        .status()
        .then(() => true)
        .catch(() => false),
    );
    assert.equal(await readFile(normal.config, "utf8"), original);
    await rm(root, { recursive: true, force: true });
    console.log(
      "RESTORED: normal service healthy; saved configuration byte-for-byte unchanged",
    );
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
