// Proof tool: exercises the Learn page's read path against the REAL service,
// using the same settings reader the daemon uses (environment, then the 0600
// env file). Prints one honest line per route — ok, status, error, or the
// payload's keys — and nothing else. The token never appears: it travels to
// the service and the envelope cannot carry it.
//
//   NODE_ENV=test npx tsx scripts/exercise-overview.ts
//
// The mint is deliberately NOT fired here: it starts a real creation turn
// (real model spend). Its logic is pinned by server/overview.test.ts against
// a scripted service double.
import { resolveSettings } from "../server/config.ts";
import { fetchLearnOverview } from "../server/overview.ts";

const settings = resolveSettings();
if (!settings.serviceUrl) {
	console.log("no service URL configured — set LEARN_SERVICE_URL in ~/.learnharness/learn-broker.env");
	process.exit(1);
}
const result = await fetchLearnOverview(settings);
console.log(`service ${result.serviceUrl} · fetched ${result.fetchedAt}`);
for (const [name, route] of Object.entries(result.routes)) {
	if (route.ok) {
		const data = route.data as unknown;
		const keys = data !== null && typeof data === "object" ? Object.keys(data as Record<string, unknown>).join(", ") : String(data);
		console.log(`  ${name}: ok · {${keys}}`);
	} else {
		const status = route.status !== undefined ? ` (HTTP ${String(route.status)})` : "";
		console.log(`  ${name}: FAIL${status} ${route.error}`);
	}
}
