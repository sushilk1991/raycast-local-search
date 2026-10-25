import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Allowlist runtime files so native source, fixtures, reports, and machine state cannot enter the Store PR.
async function main() {
  const target = process.argv[2]
    ? resolve(process.argv[2])
    : await mkdtemp(join(tmpdir(), "local-search-store-"));
  await mkdir(target, { recursive: true });
  for (const path of [
    "src",
    "assets",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "eslint.config.mjs",
  ]) {
    await cp(path, join(target, path), { recursive: true });
  }
  for (const name of [
    "agent",
    "artifacts",
    "client",
    "download",
    "install",
    "paths",
    "protocol",
  ]) {
    await mkdir(join(target, "service"), { recursive: true });
    await cp(`service/${name}.ts`, join(target, `service/${name}.ts`));
  }
  await mkdir(join(target, "media/brand"), { recursive: true });
  await cp(
    "media/brand/readme-cover.png",
    join(target, "media/brand/readme-cover.png"),
  );
  await cp("metadata", join(target, "metadata"), { recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    },
  );
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  manifest.scripts = {
    dev: "ray develop",
    build: "ray build --exit-on-error",
    lint: "ray lint --exit-on-error",
    "fix-lint": "ray lint --fix",
  };
  delete manifest.devDependencies.tsx;
  delete manifest.devDependencies.esbuild;
  await writeFile(
    join(target, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const config = JSON.parse(await readFile("tsconfig.json", "utf8"));
  config.include = ["raycast-env.d.ts", "src", "service"];
  await writeFile(
    join(target, "tsconfig.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  console.log(target);
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
