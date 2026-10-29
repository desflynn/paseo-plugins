// Pure rendering rules for the Learn page: how a service payload becomes
// rows a card can show. The service's shapes are read defensively — a field
// that is missing renders as null, never as a crash — because the page must
// survive any contract drift the envelope honestly reports. Tested here in
// shared/; client/learn.tsx only renders what these return.
export interface FieldRow {
	key: string;
	text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function compact(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "—";
	} catch {
		return "—";
	}
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return null;
}

function pickTime(record: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (!Number.isNaN(parsed)) return parsed;
		} else if (typeof value === "number" && Number.isFinite(value)) {
			// Unix seconds and milliseconds both appear in the wild; anything
			// below 10^12 is seconds.
			return value < 1e12 ? value * 1000 : value;
		}
	}
	return null;
}

/** A flat route payload as display rows: primitives as they are, nested
 *  values compact, arrays as counts. Preserves the payload's key order. */
export function fieldRows(data: unknown, limit = 8): FieldRow[] {
	const record = asRecord(data);
	if (!record) return [];
	const rows: FieldRow[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (rows.length >= limit) break;
		if (value === null || value === undefined) rows.push({ key, text: "—" });
		else if (typeof value === "string") rows.push({ key, text: value });
		else if (typeof value === "number" || typeof value === "boolean") rows.push({ key, text: String(value) });
		else if (Array.isArray(value)) rows.push({ key, text: `${value.length} ${value.length === 1 ? "item" : "items"}` });
		else rows.push({ key, text: compact(value) });
	}
	return rows;
}

export interface SessionRow {
	id: string;
	label: string;
	status: string | null;
	/** The lesson's child agent id, when the sessions surface carries it —
	 *  the Paseo-native nature of a lesson, visible not hidden. */
	childAgentId: string | null;
	at: number | null;
}

/** The sessions list: a bare array or a { sessions: [...] } wrapper, most
 *  recent first when timestamps exist, original order otherwise. */
export function sessionRows(data: unknown, limit = 6): SessionRow[] {
	const record = asRecord(data);
	const list: unknown[] = Array.isArray(data) ? data : Array.isArray(record?.sessions) ? (record!.sessions as unknown[]) : [];
	const rows: SessionRow[] = [];
	for (const raw of list) {
		const item = asRecord(raw);
		if (!item) continue;
		const id = pickString(item, ["id", "conversationId", "sessionId"]);
		if (!id) continue;
		rows.push({
			id,
			label: pickString(item, ["title", "topic", "name", "label"]) ?? id,
			// The live surface carries `phase` (e.g. concluded); `status`/`state`
			// cover the other spellings the contract allows.
			status: pickString(item, ["status", "phase", "state", "kind"]),
			childAgentId: pickString(item, ["childAgentId", "childId", "agentId"]),
			at: pickTime(item, ["updatedAt", "endedAt", "startedAt", "createdAt", "at"]),
		});
	}
	const sortable = rows.every((row) => row.at !== null);
	const ordered = sortable ? [...rows].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) : rows;
	return ordered.slice(0, limit);
}

/** The header's handshake line: "service 0.3.5 · contract 1". */
export function versionLine(data: unknown): string | null {
	const record = asRecord(data);
	if (!record) return null;
	const parts: string[] = [];
	const service = pickString(record, ["serviceVersion", "version"]);
	if (service) parts.push(`service ${service}`);
	if (record.contractVersion !== undefined && record.contractVersion !== null) parts.push(`contract ${String(record.contractVersion)}`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

export interface TutorIdentity {
	id: string | null;
	status: string | null;
}

/** The tutor's agent identity, where the surface carries it: the first of
 *  the { tutors: [...] } list, or a bare tutor object. */
export function tutorIdentity(data: unknown): TutorIdentity {
	const record = asRecord(data);
	if (!record) return { id: null, status: null };
	let source: Record<string, unknown> = record;
	if (Array.isArray(record.tutors)) {
		const first = asRecord(record.tutors[0]);
		if (!first) return { id: null, status: null };
		source = first;
	}
	return { id: pickString(source, ["id", "tutorId", "agentId"]), status: pickString(source, ["status", "state", "phase"]) };
}
