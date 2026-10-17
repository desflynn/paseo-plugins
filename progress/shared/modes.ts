// o38: the five board states Des named (16 Oct): manual, hold, spec, clear the
// board, and full auto. Hold and spec are the board's hold; clear and full auto
// are the seat's conn. A hold only pauses full auto, so the conn stays under it.
import type { Conn, Hold } from "./dashboard.ts";
import type { AgentRef } from "./overview.ts";

export const BOARD_MODES = ["manual", "hold", "spec", "clear", "fullauto"] as const;
export type BoardMode = (typeof BOARD_MODES)[number];

export const MODE_LABEL: Record<BoardMode, string> = {
  manual: "Manual",
  hold: "Hold",
  spec: "Spec",
  clear: "Clear the board",
  fullauto: "Full auto",
};

type ModeBoard = { conn?: Conn; hold?: Hold } | null;
export type AutoMode = "clear" | "fullauto";

export const isActiveMode = (mode: BoardMode) => mode === "clear" || mode === "fullauto";

// The full auto a held board still has underneath, or null for none.
export function autoUnderneath(board: ModeBoard): AutoMode | null {
  if (!board?.conn) return null;
  return board.conn.clear ? "clear" : "fullauto";
}

// A hold wins the display; with none, the conn does.
export function modeOf(board: ModeBoard): BoardMode {
  if (board?.hold) return board.hold.kind === "closed" ? "hold" : "spec";
  return autoUnderneath(board) ?? "manual";
}

export interface ModePlan {
  // What to do to the board's hold: leave it, lift it, or set a kind.
  hold: "none" | "clear" | { kind: "closed" | "speccing" };
  // The prompt for the board's owner seat, or null when nobody needs telling.
  ping: string | null;
}

const COMMAND: Record<AutoMode, string> = { fullauto: "/fullauto", clear: "/fullauto clear" };

// Only the seat can change its conn (it renames itself and files its wakes),
// so a change to the conn goes to the seat as its own command. An idle board
// turning active is told to continue.
export function planModeChange(board: ModeBoard, to: BoardMode): ModePlan {
  const from = modeOf(board);
  if (from === to) return { hold: "none", ping: null };
  const held = Boolean(board?.hold);
  const lift: ModePlan["hold"] = held ? "clear" : "none";
  const under = autoUnderneath(board);
  const said = `Des switched this board to ${MODE_LABEL[to]} from the Progress page.`;
  if (to === "hold" || to === "spec") return { hold: { kind: to === "hold" ? "closed" : "speccing" }, ping: null };
  if (to === "manual") return { hold: lift, ping: under ? `/fullauto off — ${said} Full auto is off.` : null };
  // to is "clear" or "fullauto"
  if (under === to) return { hold: lift, ping: held ? `${said} Continue.` : null };
  return { hold: lift, ping: `${COMMAND[to]} — ${said} Continue.` };
}

// The seat to ping: a live top-level agent wearing the full auto icon, else a
// Head Guy, else the busiest. A helper or a closed agent is never the owner.
export function ownerAgent(agents: AgentRef[]): AgentRef | null {
  const order: Record<AgentRef["status"], number> = { running: 0, initializing: 1, error: 2, idle: 3, closed: 4 };
  const seats = agents.filter((agent) => agent.status !== "closed" && !agent.parentAgentId);
  const score = (agent: AgentRef) => (agent.title?.includes("♾️") ? 0 : /head guy/i.test(agent.title ?? "") ? 1 : 2);
  return [...seats].sort((a, b) => score(a) - score(b) || order[a.status] - order[b.status])[0] ?? null;
}
