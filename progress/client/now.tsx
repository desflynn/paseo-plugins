import { createContext, useContext, type ReactNode } from "react";

// The panel's clock (o47.4). DashboardView ticks it every 15 s and hands it
// to its tree once, through this context; the leaves that show a time read it
// here. Only a leaf that reads the clock re-renders on the tick, so the lists
// and sections between them never do.
const Now = createContext<number | null>(null);

export function NowProvider({ now, children }: { now: number; children: ReactNode }) {
  return <Now.Provider value={now}>{children}</Now.Provider>;
}

// The pure heart of the hook: with no provider, read the real clock, so a
// component outside a panel never shows a frozen time.
export function readNow(now: number | null): number {
  return now ?? Date.now();
}

export function useNowClock(): number {
  return readNow(useContext(Now));
}
