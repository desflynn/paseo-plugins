// The Learn page's contract with its server half. Both sides import this
// file; the client never imports the server's fetchers and never sees the
// service token — every call runs through the RPC seam, and the token stays
// in the plugin's process, read from the 0600 env file (server/config.ts).
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One v1 route's outcome: the parsed payload, or an honest error with the
 *  HTTP status when the service answered. */
export type LearnRouteResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number };

/** The page's one read: every service route in one envelope. A route that
 *  fails carries its error and the page keeps rendering its siblings — one
 *  route failing must not blank the page. */
export interface LearnOverviewResult {
	/** Where the service is, so the client can build web links (the session
	 *  view). Null when no service URL is configured. Never carries the token. */
	serviceUrl: string | null;
	/** When this envelope was assembled, ISO. */
	fetchedAt: string;
	routes: {
		version: LearnRouteResult;
		graph: LearnRouteResult;
		growth: LearnRouteResult;
		sessions: LearnRouteResult;
		spend: LearnRouteResult;
		tutor: LearnRouteResult;
	};
}

/** The mint's outcome: the ids the service minted, or an honest error. The
 *  creation turn can take minutes to settle; the client holds its minting
 *  state until this resolves. */
export type LearnStartConversationResult =
	| { ok: true; conversationId: string; childId: string | null }
	| { ok: false; error: string; status?: number };

export const learnOverview = defineRpc({
	name: "learn.overview",
	input: z.object({}),
	output: z.custom<LearnOverviewResult>(),
});

export const learnStartConversation = defineRpc({
	name: "learn.conversation.start",
	input: z.object({}),
	output: z.custom<LearnStartConversationResult>(),
});
