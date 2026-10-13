// Evidence for the panel's freezes (o24). A timer that fires every 100 ms
// notices when the main thread was stuck for 250 ms or more, and the line it
// writes says what ran just before and during the stall. Marks come from the
// polls and renders; lines go to the server's perf log through `send`.
// Hook-free, so it runs in the tests without the app.

export type Mark = { at: number; what: string };

const RING_SIZE = 40;
// How far before a stall a mark still counts as "just before".
const LEAD_MS = 1_500;
const TICK_MS = 100;
const STALL_MS = 250;
const FLUSH_MS = 3_000;
const LONG_TASK_MS = 100;

export function pushMark(ring: Mark[], what: string, at: number): void {
  ring.push({ at, what });
  if (ring.length > RING_SIZE) ring.shift();
}

// One log line for a stall that ended at `endMs` and ran `lagMs`. Offsets are
// from the stall's start: negative ran before it, positive ran inside it.
export function lagLine(lagMs: number, endMs: number, marks: Mark[]): string {
  const start = endMs - lagMs;
  const around = marks
    .filter((entry) => entry.at >= start - LEAD_MS && entry.at <= endMs)
    .map((entry) => `${entry.at - start >= 0 ? "+" : ""}${entry.at - start}ms ${entry.what}`);
  return `${new Date(endMs).toISOString()} LAG ${lagMs}ms | ${around.length ? around.join("; ") : "no marks"}`;
}

const recent: Mark[] = [];
export function mark(what: string): void {
  pushMark(recent, what, Date.now());
}

type Browser = {
  document?: { visibilityState?: string };
  PerformanceObserver?: {
    new (callback: (list: { getEntries(): Array<{ duration: number }> }) => void): { observe(options: { entryTypes: string[] }): void };
    supportedEntryTypes?: readonly string[];
  };
};

let sender: ((lines: string[]) => void) | null = null;
let started = false;

// Starts the watchers once; later calls only swap who the lines go to.
export function watchPanel(send: (lines: string[]) => void): void {
  sender = send;
  if (started) return;
  started = true;
  const env = globalThis as unknown as Browser;
  const queue: string[] = [`${new Date().toISOString()} WATCH started`];
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - last - TICK_MS;
    last = now;
    // A hidden window throttles its timers; that is not a freeze.
    if (lag >= STALL_MS && env.document?.visibilityState !== "hidden") queue.push(lagLine(lag, now, recent));
  }, TICK_MS);
  try {
    if (env.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
      new env.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_MS) queue.push(`${new Date().toISOString()} LONGTASK ${Math.round(entry.duration)}ms`);
        }
      }).observe({ entryTypes: ["longtask"] });
    }
  } catch {
    // Not every runtime has long-task timing; the timer above still works.
  }
  setInterval(() => {
    if (queue.length) sender?.(queue.splice(0, 50));
  }, FLUSH_MS);
}
