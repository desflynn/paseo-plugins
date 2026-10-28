// The broker's settings home. Paseo has no per-plugin environment seam — not a
// config entry, not `plugin install --env`, and not a wrapper plugin, because the
// compiler refuses modules outside the plugin directory — so the plugin reads the
// env file the deployment already plans, and keeps the real environment as an
// override. These tests pin the format, the precedence, and the two things that
// must never happen by accident: an unset token, and an all-interfaces bind.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_HOST, DEFAULT_PORT, isWorldReadable, readEnvFile, resolveSettings, settingsPath } from "./config.ts";

async function envFile(t: { after: (fn: () => Promise<void>) => void }, body: string, mode = 0o600): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "broker-env-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "learn-broker.env");
	await writeFile(path, body);
	await chmod(path, mode);
	return path;
}

test("the settings file is the one the deployment plans", () => {
	assert.equal(settingsPath("/home/des"), "/home/des/.learnharness/learn-broker.env");
});

test("with no settings anywhere, the listener binds loopback on an ephemeral port", () => {
	const settings = resolveSettings({}, {});
	assert.equal(settings.host, "127.0.0.1", "never all interfaces by default");
	assert.equal(settings.host, DEFAULT_HOST);
	assert.equal(settings.port, DEFAULT_PORT);
	assert.equal(settings.token, null, "no token means the core refuses to start");
});

test("the env file is read as a shell would read it", async (t) => {
	const path = await envFile(
		t,
		[
			"# the broker pair",
			"",
			"LEARN_BROKER_TOKEN=pair-abc",
			'LEARN_BROKER_HOST="100.103.166.71"',
			"export LEARN_BROKER_PORT=6790",
			"LEARN_SERVICE_URL=http://svc:8080/mcp",
			"NOT A LINE",
			"1BAD=x",
		].join("\n"),
	);
	const file = readEnvFile(path);
	assert.equal(file.LEARN_BROKER_TOKEN, "pair-abc", "a bare value is read");
	assert.equal(file.LEARN_BROKER_HOST, "100.103.166.71", "one layer of quotes is stripped");
	assert.equal(file.LEARN_BROKER_PORT, "6790", "export is accepted");
	assert.equal(file.LEARN_SERVICE_URL, "http://svc:8080/mcp");
	assert.equal(file["NOT A LINE"], undefined, "a line with no = is skipped");
	assert.equal(file["1BAD"], undefined, "a key that is not a name is skipped");

	const settings = resolveSettings({}, file);
	assert.equal(settings.token, "pair-abc");
	assert.equal(settings.host, "100.103.166.71", "a deliberate tailnet bind is allowed");
	assert.equal(settings.port, 6790);
	assert.equal(settings.serviceUrl, "http://svc:8080/mcp");
});

test("the environment overrides the file, and an empty value falls back to it", async (t) => {
	const path = await envFile(t, "LEARN_BROKER_TOKEN=from-file\nLEARN_BROKER_HOST=10.0.0.1\nLEARN_BROKER_PROVIDER=claude\n");
	const file = readEnvFile(path);
	const settings = resolveSettings({ LEARN_BROKER_TOKEN: "from-env", LEARN_BROKER_HOST: "" } as NodeJS.ProcessEnv, file);
	assert.equal(settings.token, "from-env", "the real environment wins");
	assert.equal(settings.host, "10.0.0.1", "an empty environment value is unset, not an empty host");
	assert.equal(settings.provider, "claude", "the file still supplies what the environment does not");
});

test("a bad port in either source falls back instead of binding something absurd", () => {
	assert.equal(resolveSettings({ LEARN_BROKER_PORT: "not-a-port" } as NodeJS.ProcessEnv, {}).port, DEFAULT_PORT);
	assert.equal(resolveSettings({ LEARN_BROKER_PORT: "70000" } as NodeJS.ProcessEnv, {}).port, DEFAULT_PORT);
	assert.equal(resolveSettings({}, { LEARN_BROKER_PORT: "65535" }).port, 65535);
	assert.equal(resolveSettings({}, { LEARN_BROKER_PORT: "" }).port, DEFAULT_PORT);
});

test("a missing or broken file is not an error", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "broker-env-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	assert.deepEqual(readEnvFile(join(home, "absent.env")), {}, "a missing file is empty settings");
	const broken = join(home, "broken.env");
	await writeFile(broken, "\u0000\u0001garbage");
	assert.deepEqual(readEnvFile(broken), {}, "a file that parses to nothing usable is empty settings");
});

test("a token file the whole box can read is reported, not silently accepted", async (t) => {
	const open = await envFile(t, "LEARN_BROKER_TOKEN=x\n", 0o644);
	assert.equal(isWorldReadable(open), true, "group or world readable is caught");
	const closed = await envFile(t, "LEARN_BROKER_TOKEN=x\n", 0o600);
	assert.equal(isWorldReadable(closed), false, "owner-only is the shape we want");
	assert.equal(isWorldReadable(join(tmpdir(), "definitely-absent.env")), false, "a missing file is not a warning");
});
