import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Replace only this extension's tree; expected-head and non-force updates protect concurrent review work.
const REPO = "sushilk1991/extensions";
const BRANCH = "local-content-search";
const NAME = "local-content-search";
type Entry = { path: string; mode: string; type: string; sha: string };
function api(route: string, body?: unknown) {
  return JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${REPO}/${route}`,
        ...(body === undefined ? [] : ["--method", "POST", "--input", "-"]),
      ],
      {
        input: body === undefined ? undefined : JSON.stringify(body),
        encoding: "utf8",
        maxBuffer: 8 * 1024 ** 2,
      },
    ),
  );
}
async function collect(root: string, prefix = ""): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    if (
      ["node_modules", "dist", ".git"].includes(entry.name) ||
      entry.name === "raycast-env.d.ts"
    ) {
      continue;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      names.push(...(await collect(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unexpected non-file ${path}`);
    }
    names.push(path);
  }
  return names.sort();
}
async function main() {
  const stage = process.argv[2] && resolve(process.argv[2]);
  const expected = process.argv[3];
  if (!stage || !expected) {
    throw new Error(
      "Pass the validated staging directory and expected fork branch SHA",
    );
  }
  const head = api(`git/ref/heads/${BRANCH}`).object.sha;
  if (head !== expected) {
    throw new Error(
      "PR head changed; inspect the new feedback before publishing",
    );
  }
  const commit = api(`git/commits/${head}`);
  const root = api(`git/trees/${commit.tree.sha}`).tree as Entry[];
  const extensions = root.find((entry) => entry.path === "extensions")!;
  const extensionRoots = api(`git/trees/${extensions.sha}`).tree as Entry[];
  const previous = extensionRoots.find((entry) => entry.path === NAME)!;
  const oldEntries = api(`git/trees/${previous.sha}?recursive=1`)
    .tree as Entry[];
  const oldHashes = new Set(oldEntries.map((entry) => entry.sha));
  const tree: Entry[] = [];
  for (const path of await collect(stage)) {
    if (
      /^(native|tests|scripts|docs|examples)\//.test(path) ||
      ["STATE.md", "PROGRESS.md"].includes(path)
    ) {
      throw new Error(`Development file in Store package: ${path}`);
    }
    const bytes = await readFile(join(stage, path));
    const sha = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (!oldHashes.has(sha)) {
      const uploaded = api("git/blobs", {
        content: bytes.toString("base64"),
        encoding: "base64",
      });
      if (uploaded.sha !== sha) {
        throw new Error(`Blob mismatch: ${path}`);
      }
    }
    tree.push({ path, mode: "100644", type: "blob", sha });
  }
  const extensionTree = api("git/trees", { tree }).sha;
  const extensionsTree = api("git/trees", {
    base_tree: extensions.sha,
    tree: [{ path: NAME, mode: "040000", type: "tree", sha: extensionTree }],
  }).sha;
  const rootTree = api("git/trees", {
    base_tree: commit.tree.sha,
    tree: [
      { path: "extensions", mode: "040000", type: "tree", sha: extensionsTree },
    ],
  }).sha;
  const next = api("git/commits", {
    message: process.argv[4] ?? "Install the search helper from Store commands",
    tree: rootTree,
    parents: [head],
  }).sha;
  execFileSync(
    "gh",
    [
      "api",
      `repos/${REPO}/git/refs/heads/${BRANCH}`,
      "--method",
      "PATCH",
      "--input",
      "-",
    ],
    { input: JSON.stringify({ sha: next, force: false }) },
  );
  // Compare the published tree, including deletions, with the exact package that passed the local gate.
  const published = api(`git/trees/${extensionTree}?recursive=1`).tree.filter(
    (entry: Entry) => entry.type === "blob",
  ) as Entry[];
  if (
    published.length !== tree.length ||
    tree.some(
      (entry) =>
        !published.some(
          (value) => value.path === entry.path && value.sha === entry.sha,
        ),
    )
  ) {
    throw new Error("Published file verification failed");
  }
  console.log(
    JSON.stringify({ head: next, files: tree.length, verified: true }, null, 2),
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
