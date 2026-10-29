// A production install runs `npm ci --omit=dev`. Two different rules apply,
// and mixing them up caused the ideaPad outage (o69, ported from progress):
//
//   node side  - the daemon and the RPC handlers run under plain node, so
//                every package they import must be a real dependency.
//   client side - the panel is bundled by Paseo, which supplies React and
//                React Native as peers of @getpaseo/plugin, so those may stay
//                undeclared.
//
// Anything the client imports that Paseo does NOT supply must still be a
// dependency, because nothing else will install it.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Packages the Paseo host provides to a plugin's client code. They are peers of
// @getpaseo/plugin, so a plugin must not try to install its own copy.
const HOST_PROVIDED = new Set(["react", "react-native", "@getpaseo/client", "@getpaseo/protocol"]);

const NODE_ENTRIES = ["index.server.ts"];
const NODE_FOLDERS = ["server", "shared"];
const CLIENT_ENTRIES = ["index.client.tsx"];
const CLIENT_FOLDERS = ["client"];

async function sources(entries: string[], folders: string[]): Promise<string[]> {
	const files = entries.map((entry) => join(root, entry));
	for (const folder of folders) {
		for (const name of await readdir(join(root, folder)).catch(() => [] as string[])) {
			if (!/\.(ts|tsx)$/.test(name) || /\.test\.ts$/.test(name)) continue;
			files.push(join(root, folder, name));
		}
	}
	return files;
}

// The package a specifier belongs to: "@getpaseo/plugin/server" is "@getpaseo/plugin".
function packageName(specifier: string): string | null {
	if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

// Type-only imports are erased before anything runs, so they need no dependency.
async function importedPackages(entries: string[], folders: string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const file of await sources(entries, folders)) {
		const text = await readFile(file, "utf8").catch(() => "");
		for (const line of text.split("\n")) {
			if (/^\s*import\s+type\b/.test(line)) continue;
			const match = /(?:from|import)\s+"([^"]+)"/.exec(line);
			const name = match && packageName(match[1]!);
			if (name && !found.has(name)) found.set(name, file.slice(root.length + 1));
		}
	}
	return found;
}

async function manifest(): Promise<{ dependencies: Record<string, string>; devDependencies: Record<string, string>; requirements: { paseo?: string } }> {
	const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const plugin = JSON.parse(await readFile(join(root, "paseo-plugin.json"), "utf8")) as { requirements?: { paseo?: string } };
	return { dependencies: parsed.dependencies ?? {}, devDependencies: parsed.devDependencies ?? {}, requirements: plugin.requirements ?? {} };
}

test("everything the node side imports is a dependency", async () => {
	const { dependencies, devDependencies } = await manifest();
	const imported = await importedPackages(NODE_ENTRIES, NODE_FOLDERS);
	const missing = [...imported]
		.filter(([name]) => !(name in dependencies))
		.map(([name, file]) => `${name} (imported by ${file}${name in devDependencies ? ", declared dev-only" : ""})`);
	assert.deepEqual(missing, [], `a production install cannot load these on the node side:\n  ${missing.join("\n  ")}`);
});

test("the client imports nothing that neither we nor Paseo installs", async () => {
	const { dependencies } = await manifest();
	const imported = await importedPackages(CLIENT_ENTRIES, CLIENT_FOLDERS);
	const missing = [...imported]
		.filter(([name]) => !(name in dependencies) && !HOST_PROVIDED.has(name))
		.map(([name, file]) => `${name} (imported by ${file})`);
	assert.deepEqual(missing, [], `the panel would fail to bundle on these:\n  ${missing.join("\n  ")}`);
});

// The fix must not go the other way: a dependency nothing imports costs every
// production install for no reason.
test("dependencies hold only packages the plugin actually imports", async () => {
	const { dependencies } = await manifest();
	const imported = new Map([...(await importedPackages(NODE_ENTRIES, NODE_FOLDERS)), ...(await importedPackages(CLIENT_ENTRIES, CLIENT_FOLDERS))]);
	const unused = Object.keys(dependencies).filter((name) => !imported.has(name));
	assert.deepEqual(unused, [], `these dependencies are imported by no source file: ${unused.join(", ")}`);
});

// A client entry makes the connected app check requirements.paseo, so the floor
// must cover the Paseo builds the page is proven on — the same floor progress
// ships (>=0.11.0), never a speculative lower one.
test("the manifest's paseo floor matches the proven client floor", async () => {
	const { requirements } = await manifest();
	assert.equal(requirements.paseo, ">=0.11.0");
});
