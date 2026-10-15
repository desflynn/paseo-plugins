import type { Dashboard, Ticket } from "./dashboard.ts";
import { headlineText, shortTitle, ticketName } from "./dashboard.ts";
import { formatAgo, formatClock, formatEstimate, formatMinutes, formatWorkDone, minutesSince } from "./format.ts";

const STATUS: Record<string, string> = { open: "Open", in_progress: "In progress", blocked: "Blocked" };

// One objective as plain text: its line (id, status, a set priority, estimate,
// composed name) and its source. An unset priority prints nothing.
export function ticketLines(ticket: Ticket): string[] {
  const stage = ticket.status === "in_progress" && ticket.stage ? `, ${ticket.stage} stage` : "";
  const status = ticket.waitingFor ? `Waiting for ${ticket.waitingFor.id}`
    : ticket.status === "closed" ? (ticket.closeReason === "skipped" ? "Skipped" : "Done")
    : STATUS[ticket.status];
  const priority = ticket.priority === undefined ? "" : `P${ticket.priority}  `;
  // The name column carries the full composed form (id + linked bead and
  // GitHub issue + title): the machine surface for agents.
  const lines = [`  ${ticket.id}  ${status}${stage}  ${priority}${formatEstimate(ticket.estimateMin)}  ${ticketName(ticket)}`];
  if (ticket.source) lines.push(`      Source: ${ticket.source.path ?? ticket.source.url}${ticket.source.label ? ` (${ticket.source.label})` : ""}`);
  return lines;
}

// The dashboard as plain text, so an agent can check what the user sees.
export function dashboardText(dashboard: Dashboard, nowMs: number): string {
  if (!dashboard.run && !dashboard.tickets.length) return "No run yet. Start one with: paseo-progress start \"<title>\"";
  const lines: string[] = [];
  const when = (iso: string) => `${formatClock(iso)} (${formatAgo(iso, nowMs)})`;
  lines.push(dashboard.run?.title ?? "Progress");
  if (dashboard.run?.subtitle) lines.push(dashboard.run.subtitle);
  lines.push(headlineText(dashboard));
  if (dashboard.run?.finished) {
    lines.push(`Finished ${when(dashboard.run.finished.at)}: ${dashboard.run.finished.outcome}`);
    lines.push(`This run is closed. Start new work with: paseo-progress start "<title>" --replace`);
  }
  if (dashboard.ticker) lines.push(`Now: ${dashboard.ticker.text}`);
  if (dashboard.updatedAt) lines.push(`Last updated ${when(dashboard.updatedAt)}`);
  if (dashboard.stale && dashboard.updatedAt) lines.push(`POSSIBLY STALE: no update for ${formatMinutes(minutesSince(dashboard.updatedAt, nowMs))}.`);
  if (dashboard.progress.totalMin) {
    lines.push(`${dashboard.progress.percent}% of estimated work done, ${dashboard.progress.tookMin !== undefined ? "took " : ""}${formatWorkDone(dashboard.progress.doneMin, dashboard.progress.totalMin, dashboard.progress.tookMin)}`);
  }
  if (dashboard.issues.length) {
    lines.push("", `Skipped lines: ${dashboard.issues.map((issue) => `line ${issue.line} (${issue.reason})`).join(", ")}`);
  }
  if (dashboard.stuck.length) {
    lines.push("", "Stuck");
    for (const item of dashboard.stuck) {
      const detail = item.kind === "overdue" ? `no update for longer than its ${formatMinutes(item.estimateMin)} estimate`
        : item.kind === "blocked" ? `blocked${item.note ? `: ${item.note}` : ""}`
        : `${item.id}: ${item.reason}`;
      lines.push(`  ${item.title} (${detail}), since ${when(item.since)}`);
    }
  }
  lines.push("", `${dashboard.run?.itemLabel ?? "Objective"}s`);
  for (const ticket of dashboard.tickets) lines.push(...ticketLines(ticket));
  if (dashboard.questions.open.length) {
    lines.push("", "Questions waiting");
    for (const question of dashboard.questions.open) {
      lines.push(`  ${question.id} ${question.ticketId ? `[${question.ticketId}] ` : ""}(${question.title}): ${question.question} You recommended ${question.recommended}`);
      for (const option of question.options) lines.push(`      ${option.letter}) ${option.label}${option.consequence ? `: ${option.consequence}` : ""}`);
    }
  }
  if (dashboard.questions.answered.length) {
    lines.push("", "Answered");
    for (const question of dashboard.questions.answered) {
      lines.push(`  ${question.id} (${question.title}): ${question.answer!.choice}${question.answer!.changedCourse ? " (changed course)" : ""}`);
    }
  }
  if (dashboard.deliverables.length) {
    lines.push("", "Latest deliverables");
    for (const deliverable of dashboard.deliverables.slice(0, 5)) {
      const ticket = deliverable.ticketId ? `, ${deliverable.ticketLabel ?? shortTitle(deliverable.ticketId)}` : "";
      lines.push(`  ${deliverable.id}  ${deliverable.title}: ${deliverable.url ?? deliverable.path}${ticket}`);
    }
  }
  if (dashboard.activity.length) {
    lines.push("", "Activity");
    for (const entry of dashboard.activity.slice(0, 5)) lines.push(`  ${entry.id}  ${entry.ticketId ? `[${entry.ticketId}] ` : ""}${entry.text} (${formatAgo(entry.at, nowMs)})`);
  }
  return lines.join("\n");
}
