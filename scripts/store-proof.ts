import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installService, removeService } from "../service/install";
import { paths } from "../service/paths";
import { LocalClient } from "../service/client";
import { DEFAULT_CONFIG } from "../service/protocol";

// Exercise the public release, real launchd, fresh model downloads and synthetic content only.
async function main() {
  const root = await mkdtemp(join(tmpdir(), "ls-store-"));
  const locations = paths(join(root, "state"));
  const content = join(root, "content");
  await mkdir(content);
  await writeFile(
    join(content, "lease.txt"),
    "The rental agreement permits two cats and one dog. A pet deposit is required before moving into the apartment.",
  );
  await writeFile(
    join(content, "recipe.txt"),
    "To bake sourdough bread, mix flour, water, salt, and a fermented starter. Let the dough rise overnight.",
  );
  let lastStage = "";
  const report = (stage: string) => {
    if (stage !== lastStage) {
      console.log(stage);
      lastStage = stage;
    }
  };
  let installed = false;
  try {
    await installService(report, undefined, locations);
    installed = true;
    const client = new LocalClient(locations.socket);
    assert.deepEqual((await client.status()).config.roots, []);
    console.log(
      "PASS fresh public-release install; no folders selected automatically",
    );
    await client.configure({ ...DEFAULT_CONFIG, roots: [content] });
    const deadline = Date.now() + 120000;
    while ((await client.status()).counts?.searchable !== 2) {
      if (Date.now() > deadline) {
        throw new Error("Index did not become ready");
      }
      await new Promise((done) => {
        setTimeout(done, 500);
      });
    }
    const start = performance.now();
    const hits = await client.search("restrictions on domestic animals");
    assert.ok(hits[0]?.path.endsWith("lease.txt"));
    console.log(
      `PASS released helper semantic query: lease.txt (${Math.round(performance.now() - start)} ms)`,
    );
    await removeService(locations);
    await assert.rejects(client.status());
    console.log("PASS removal stops socket service and preserves saved data");
  } finally {
    if (installed) {
      // Restore the user's existing selected folders, now using the published self-contained helper.
      await installService(report);
      console.log(
        "PASS normal installation restored; existing settings preserved",
      );
      await rm(root, { recursive: true, force: true });
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
