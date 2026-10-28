#!/usr/bin/env node
// Build the production node_modules for the progress plugin, as one portable
// tarball. A box installs this instead of running npm, so an x64 box can take a
// tree built on this arm64 Mac: `--omit=dev` drops the tooling and
// `--legacy-peer-deps` drops the peers Paseo supplies to the panel (react,
// react-native), which leaves plain JavaScript and no compiled binaries.
//
//   node scripts/plugin-prod-bundle.mjs [--out <dir>]
//
// Prints the tarball path, its sha256 and the plugin commit, so a box can verify
// what it is about to install before it touches a live tree.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(repo, "progress");

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

const outIndex = process.argv.indexOf("--out");
const outDir = outIndex > -1 ? resolve(process.argv[outIndex + 1]) : tmpdir();

const commit = git("rev-parse", "--short", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
// A dated .bak- file left beside a skill is not the tree that runs, so it does
// not make the bundle dirty. Anything else in progress/ does.
const dirty = git("status", "--porcelain", "--", "progress")
  .split("\n")
  .filter((line) => line.trim() !== "" && !/\.bak-/.test(line))
  .join("\n") !== "";

// The manifest and lock travel with the tree: the box proves what it installed
// against the same two files the bundle was built from.
const scratch = await mkdtemp(join(tmpdir(), "progress-bundle-"));
try {
  execFileSync("sh", ["-c", `tar --exclude=node_modules -cf - . | (cd ${JSON.stringify(scratch)} && tar xf -)`], { cwd: plugin });
  execFileSync("npm", ["ci", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
    cwd: scratch,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const name = `progress-node_modules-${commit}.tar.gz`;
  const tarball = join(outDir, name);
  execFileSync("tar", ["-czf", tarball, "-C", scratch, "node_modules"]);

  const bytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const size = (await stat(tarball)).size;

  await writeFile(`${tarball}.sha256`, `${sha256}  ${name}\n`);

  const manifest = {
    plugin: "progress",
    branch,
    commit,
    workingTreeDirty: dirty,
    builtAt: new Date().toISOString(),
    builtOn: `${process.platform}-${process.arch}`,
    node: process.version,
    install: "npm ci --omit=dev --legacy-peer-deps",
    tarball: name,
    bytes: size,
    sha256,
  };
  await writeFile(`${tarball}.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify(manifest, null, 2));
  if (dirty) console.error("warning: progress/ has uncommitted changes; the bundle is not the commit above");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
