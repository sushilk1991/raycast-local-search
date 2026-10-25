import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "../service/paths";
import { LocalClient } from "../service/client";
import { AGENT_LABEL } from "../service/agent";
import { installationState, restartService } from "../service/install";

// Stop this service, forbid fetch, recover cached artifacts, and preserve the user's exact configuration.
const exec = promisify(execFile);
const WAIT_MS = 20000;
async function wait(check: () => Promise<boolean>) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Service transition timed out");
    }
    await new Promise((done) => {
      setTimeout(done, 250);
    });
  }
}
async function main() {
  const locations = paths();
  const before = await readFile(locations.config, "utf8");
  const client = new LocalClient();
  await client.status();
  const fetch = globalThis.fetch;
  let network = 0;
  try {
    await exec("/bin/launchctl", [
      "bootout",
      `gui/${process.getuid!()}/${AGENT_LABEL}`,
    ]);
    await wait(() =>
      client
        .status()
        .then(() => false)
        .catch(() => true),
    );
    assert.equal(await installationState(), "stopped");
    globalThis.fetch = async () => {
      network += 1;
      throw new Error("Network disabled by offline proof");
    };
    await restartService((stage) => console.log(stage));
    assert.equal(await installationState(), "ready");
    assert.equal(network, 0);
    assert.equal(await readFile(locations.config, "utf8"), before);
    console.log(
      "PASS real launchd restart with fetch disabled, zero network calls, and byte-identical configuration",
    );
  } finally {
    globalThis.fetch = fetch;
    // Restore registration even if the assertion or recovery implementation fails.
    if (
      !(await client
        .status()
        .then(() => true)
        .catch(() => false))
    ) {
      const plist = join(
        homedir(),
        "Library/LaunchAgents",
        `${AGENT_LABEL}.plist`,
      );
      await exec("/bin/launchctl", [
        "bootstrap",
        `gui/${process.getuid!()}`,
        plist,
      ]).catch(async () => {
        await exec("/bin/launchctl", [
          "kickstart",
          "-k",
          `gui/${process.getuid!()}/${AGENT_LABEL}`,
        ]);
      });
      await wait(() =>
        client
          .status()
          .then(() => true)
          .catch(() => false),
      );
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
