import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Package only relocatable binaries and notices; never models or developer machine state.
const NODE_SHA256 =
  "db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000";
const NODE_ARCHIVE = process.argv[2];
const VERSION = "0.2.1";
async function main() {
  if (!NODE_ARCHIVE) {
    throw new Error(
      "Pass the official node-v22.22.2-darwin-arm64.tar.gz archive",
    );
  }
  const hash = createHash("sha256")
    .update(await readFile(NODE_ARCHIVE))
    .digest("hex");
  if (hash !== NODE_SHA256) {
    throw new Error("Official Node archive checksum mismatch");
  }
  const stage = await mkdtemp(join(tmpdir(), "local-search-release-"));
  const helper = join(stage, "helper");
  await mkdir(join(helper, "bin"), { recursive: true });
  await mkdir(join(helper, "licenses"));
  execFileSync("/usr/bin/tar", ["-xzf", resolve(NODE_ARCHIVE), "-C", stage]);
  await copyFile(
    join(stage, "node-v22.22.2-darwin-arm64/bin/node"),
    join(helper, "bin/node"),
  );
  await copyFile(
    join(stage, "node-v22.22.2-darwin-arm64/LICENSE"),
    join(helper, "licenses/LICENSE-Node"),
  );
  await copyFile(
    "native/.build/release/local-search-engine",
    join(helper, "bin/local-search-engine"),
  );
  await copyFile("dist/service.cjs", join(helper, "bin/service.cjs"));
  for (const file of [
    "LICENSE-DigUp",
    "LICENSE-llama.cpp",
    "LICENSE-EmbeddingGemma2",
  ]) {
    await copyFile(join("native", file), join(helper, "licenses", file));
  }
  await copyFile("LICENSE", join(helper, "licenses/LICENSE-LocalSearch"));
  await copyFile(
    "THIRD_PARTY_NOTICES.md",
    join(helper, "licenses/THIRD_PARTY_NOTICES.md"),
  );
  await writeFile(join(helper, "version"), VERSION);
  const target = resolve(
    `dist/local-search-helper-${VERSION}-darwin-arm64.tar.gz`,
  );
  execFileSync("/usr/bin/tar", [
    "-czf",
    target,
    "-C",
    helper,
    "bin",
    "licenses",
    "version",
  ]);
  const archive = await readFile(target);
  console.log(
    JSON.stringify(
      {
        target,
        bytes: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
      null,
      2,
    ),
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
