import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "progress";

// The launcher never names a plugin folder. Each run asks Paseo which copy of
// the plugin it is running, so updates and `npm run dev` switches keep working.
export function launcherScript(): string {
  return `#!/usr/bin/env node
// Written by the ${PLUGIN_ID} Paseo plugin. Runs the progress command from the
// copy of the plugin Paseo is running now.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error("paseo-progress needs Node.js 22.18 or later; this is " + process.version + ".");
  process.exit(1);
}
// Not require: a package.json with "type": "module" above this folder makes Node load it as ESM.
const { spawnSync } = process.getBuiltinModule("node:child_process");
const { existsSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");

function pluginDirectory() {
  if (process.env.PASEO_PROGRESS_PLUGIN_DIR) return process.env.PASEO_PROGRESS_PLUGIN_DIR;
  const clis = [process.env.PASEO_BIN, "paseo", "/Applications/Paseo.app/Contents/Resources/bin/paseo"].filter(Boolean);
  for (const cli of clis) {
    const result = spawnSync(cli, ["plugin", "ls", "${PLUGIN_ID}", "--json"], { encoding: "utf8" });
    if (result.error || result.status !== 0) continue;
    try {
      const plugin = JSON.parse(result.stdout).find((entry) => entry.id === "${PLUGIN_ID}");
      return plugin && plugin.path;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Always the plugin's source: the same code a reload hands the panel, so
// the command can never lag behind it on an old compiled copy.
const directory = pluginDirectory();
const entry = directory && [join(directory, "server", "cli.ts")].find((path) => existsSync(path));
if (!entry) {
  console.error("The ${PLUGIN_ID} plugin is not installed in Paseo, or Paseo is not reachable. Check with: paseo plugin ls");
  process.exit(1);
}
const run = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status === null ? 1 : run.status);
`;
}

const MARKER = `Written by the ${PLUGIN_ID} Paseo plugin`;
// The boards shim's own line, present before the marker was added to it.
const BOARDS_SIGNATURE = "Runs server/boards.ts from the copy of the plugin";

export function defaultLauncherPath(home = homedir()): string {
  return join(home, ".local", "bin", "paseo-progress");
}

export type LauncherState = "missing" | "current" | "outdated" | "foreign";

export async function launcherState(path: string): Promise<LauncherState> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === null) return "missing";
  if (current === launcherScript()) return "current";
  return current.includes(MARKER) ? "outdated" : "foreign";
}

// Writes the launcher when it is missing or out of date. Never replaces a file
// something else put there. Returns whether it wrote.
export async function installLauncher(path: string): Promise<boolean> {
  const state = await launcherState(path);
  if (state === "current") return false;
  if (state === "foreign") throw new Error(`${path} already exists and was not written by this plugin. Move it, or pass another path.`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, launcherScript());
  await chmod(path, 0o755);
  return true;
}

// For the panel: whether agents on the daemon host can run `paseo-progress`.
export async function launcherStatus(path = defaultLauncherPath(), pathEnv = process.env.PATH ?? "") {
  return {
    path,
    state: await launcherState(path),
    onPath: pathEnv.split(delimiter).some((entry) => entry.replace(/\/+$/, "") === dirname(path)),
  };
}

export async function handleLauncherStatus() {
  return launcherStatus();
}

// Runs only when the user presses Install in the panel: both shims go on PATH.
export async function handleInstallLauncher() {
  const path = defaultLauncherPath();
  await installLaunchers(path);
  return launcherStatus(path);
}

// The boards fold ships as its own shim beside paseo-progress, so the global doc
// runs from the same plugin copy the panel does. Same install rules, same marker.
export function defaultBoardsPath(home = homedir()): string {
  return join(home, ".local", "bin", "paseo-boards");
}

// The source is a shipped file, not a string built here: it carries its own
// version checks and Paseo lookup, and it must stay identical to what it says.
async function boardsScript(): Promise<string> {
  return readFile(join(dirname(fileURLToPath(import.meta.url)), "boards-launcher"), "utf8");
}
export async function boardsLauncherState(path: string): Promise<LauncherState> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === null) return "missing";
  if (current === (await boardsScript())) return "current";
  // The first boards shim shipped before the marker existed; it is ours, so
  // update it rather than refuse it. Anything else in that slot is foreign.
  return current.includes(MARKER) || current.includes(BOARDS_SIGNATURE) ? "outdated" : "foreign";
}

export async function installBoardsLauncher(path: string): Promise<boolean> {
  const state = await boardsLauncherState(path);
  if (state === "current") return false;
  if (state === "foreign") throw new Error(`${path} already exists and was not written by this plugin. Move it, or pass another path.`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await boardsScript());
  await chmod(path, 0o755);
  return true;
}

// A box's harness boards endpoint runs this reader. A box that runs the plugin
// but never pressed Install has no reader, so the endpoint answers 503 while
// looking healthy. Ensure it at startup: missing or outdated gets written, a
// file this plugin did not write is left alone, and a failure never blocks the
// plugin from loading.
export async function ensureBoardsLauncher(path = defaultBoardsPath()): Promise<boolean> {
  try {
    return await installBoardsLauncher(path);
  } catch {
    return false;
  }
}

export async function boardsLauncherStatus(path = defaultBoardsPath(), pathEnv = process.env.PATH ?? "") {
  return {
    path,
    state: await boardsLauncherState(path),
    onPath: pathEnv.split(delimiter).some((entry) => entry.replace(/\/+$/, "") === dirname(path)),
  };
}

// One Install press puts both shims on PATH, in the same folder. Returns
// whether it wrote either of them, so the caller can say "already current".
export async function installLaunchers(path: string): Promise<boolean> {
  const progress = await installLauncher(path);
  const boards = await installBoardsLauncher(join(dirname(path), "paseo-boards"));
  return progress || boards;
}
