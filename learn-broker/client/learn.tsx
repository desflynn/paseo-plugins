// The Learn screen (learn-on-paseo P6): the service's live v1 contract on one
// page — version handshake, graph totals and growth, sessions with their
// child agent ids, spend (the money truth), and the tutor's agent identity.
// Data arrives through the two RPC seams in shared/rpc.ts; the client never
// holds the service token. Rules are pure and tested in shared/shape.ts;
// this file is data loading and rendering.
import { openExternalUrl, useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import type { RpcOutput } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";
import { learnOverview, learnStartConversation, type LearnRouteResult } from "../shared/rpc.ts";
import { fieldRows, sessionRows, tutorIdentity, versionLine, type SessionRow } from "../shared/shape.ts";

export const LEARN_SCREEN_ID = "learn";

type Overview = RpcOutput<typeof learnOverview>;
type Colors = PluginScreenProps["theme"]["colors"];

const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" } as const;

function clock(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The page's one read. Loads on mount, refreshes when the app returns to the
// foreground, and exposes a manual refresh for the header button.
function useLearnOverview() {
	const fetchOverview = useRpc(learnOverview);
	const [state, setState] = useState<{ data?: Overview; error?: string; loading: boolean }>({ loading: true });
	const load = useCallback(async () => {
		setState((current) => ({ ...current, loading: true, error: undefined }));
		try {
			const data = await fetchOverview({});
			setState({ data, loading: false });
		} catch (err) {
			setState((current) => ({ ...current, loading: false, error: err instanceof Error ? err.message : String(err) }));
		}
	}, [fetchOverview]);
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		const subscription = AppState.addEventListener("change", (next) => {
			if (next === "active") void load();
		});
		return () => subscription.remove();
	}, [load]);
	return { ...state, refresh: load };
}

function Card({ colors, title, children }: { colors: Colors; title?: string; children: React.ReactNode }) {
	return (
		<View style={{ marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, gap: 6 }}>
			{title ? <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{title}</Text> : null}
			{children}
		</View>
	);
}

function RouteErrorLine({ colors, result }: { colors: Colors; result: LearnRouteResult }) {
	if (result.ok) return null;
	const status = "status" in result && result.status !== undefined ? ` (HTTP ${String(result.status)})` : "";
	return (
		<Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17 }}>
			Unreachable — {result.error}
			{status}
		</Text>
	);
}

function Dot({ colors, ok }: { colors: Colors; ok: boolean }) {
	return <View accessibilityLabel={ok ? "handshake ok" : "handshake failed"} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok ? colors.statusSuccess : colors.statusDanger }} />;
}

function Fields({ colors, rows }: { colors: Colors; rows: { key: string; text: string }[] }) {
	if (!rows.length) return <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Nothing here yet.</Text>;
	return (
		<View style={{ gap: 3 }}>
			{rows.map((row) => (
				<View key={row.key} style={{ flexDirection: "row", columnGap: 8, minWidth: 0 }}>
					<Text numberOfLines={1} style={{ flexShrink: 0, color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{row.key}</Text>
					<Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 12, lineHeight: 17, ...mono }}>{row.text}</Text>
				</View>
			))}
		</View>
	);
}

function RouteCard({ colors, title, result }: { colors: Colors; title: string; result: LearnRouteResult }) {
	return (
		<Card colors={colors} title={title}>
			{result.ok ? <Fields colors={colors} rows={fieldRows(result.data)} /> : <RouteErrorLine colors={colors} result={result} />}
		</Card>
	);
}

function SessionRowLine({ colors, row }: { colors: Colors; row: SessionRow }) {
	return (
		<View style={{ flexDirection: "row", alignItems: "center", columnGap: 8, minWidth: 0 }}>
			<Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: colors.foreground, fontSize: 12, lineHeight: 17 }}>{row.label}</Text>
			<View style={{ flex: 1 }} />
			{row.childAgentId ? <Text numberOfLines={1} style={{ flexShrink: 0, color: colors.foregroundMuted, fontSize: 11, lineHeight: 16, ...mono }}>agent {row.childAgentId}</Text> : null}
			{row.status ? <Text numberOfLines={1} style={{ flexShrink: 0, color: colors.statusSuccess, fontSize: 11, lineHeight: 16 }}>{row.status}</Text> : null}
		</View>
	);
}

// "New conversation": mints a session on the service and hands the learner
// straight to the live session view. The creation turn can take minutes, so
// the button holds its minting state until the mint resolves — then the web
// session view carries the wait.
function NewConversationCard({ colors, serviceUrl, onMinted }: { colors: Colors; serviceUrl: string | null; onMinted(): void }) {
	const startConversation = useRpc(learnStartConversation);
	const [minting, setMinting] = useState(false);
	const [mintError, setMintError] = useState<string | null>(null);
	const mint = async () => {
		if (minting || !serviceUrl) return;
		setMinting(true);
		setMintError(null);
		const result = await startConversation({});
		setMinting(false);
		if (result.ok) {
			onMinted();
			openExternalUrl(`${serviceUrl}/conversation/${result.conversationId}`);
		} else {
			const status = result.status !== undefined ? ` (HTTP ${String(result.status)})` : "";
			setMintError(`${result.error}${status}`);
		}
	};
	const disabled = minting || !serviceUrl;
	return (
		<Card colors={colors}>
			<Pressable accessibilityRole="button" accessibilityLabel="New conversation" disabled={disabled} onPress={() => void mint()}
				style={({ hovered }) => ({ flexDirection: "row", alignItems: "center", columnGap: 8, paddingVertical: 4, opacity: disabled ? 0.6 : 1 })}>
				<Icon name={minting ? "RefreshCw" : "Plus"} size={15} color={minting ? colors.foregroundMuted : colors.foreground} />
				<Text style={{ color: minting ? colors.foregroundMuted : colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>
					{minting ? "Minting…" : "New conversation"}
				</Text>
			</Pressable>
			<Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
				{minting
					? "The creation turn can take a few minutes; the session view holds the wait."
					: "Starts a lesson on the service and opens its live session view."}
			</Text>
			{mintError ? <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17 }}>{mintError}</Text> : null}
		</Card>
	);
}

function TutorCard({ colors, result }: { colors: Colors; result: LearnRouteResult }) {
	const identity = result.ok ? tutorIdentity(result.data) : null;
	return (
		<Card colors={colors} title="Tutor">
			{result.ok ? (
				<>
					{identity?.id ? (
						<View style={{ flexDirection: "row", columnGap: 8, minWidth: 0 }}>
							<Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>agent</Text>
							<Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, lineHeight: 17, ...mono }}>
								{identity.id}
								{identity.status ? ` · ${identity.status}` : ""}
							</Text>
						</View>
					) : null}
					<Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 18 }}>Your tutor and every lesson run as Paseo agents.</Text>
					<Fields colors={colors} rows={fieldRows(result.data, 4)} />
				</>
			) : (
				<RouteErrorLine colors={colors} result={result} />
			)}
		</Card>
	);
}

function OpenSessionViewCard({ colors, serviceUrl }: { colors: Colors; serviceUrl: string | null }) {
	return (
		<Card colors={colors}>
			<Pressable accessibilityRole="button" accessibilityLabel="Open session view" disabled={!serviceUrl} onPress={() => serviceUrl && openExternalUrl(`${serviceUrl}/conversations`)}
				style={{ flexDirection: "row", alignItems: "center", columnGap: 8, paddingVertical: 4, opacity: serviceUrl ? 1 : 0.6 }}>
				<Icon name="ExternalLink" size={15} color={colors.foregroundMuted} />
				<Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>Open session view</Text>
			</Pressable>
			<Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Learn's own web UI, one tap away.</Text>
		</Card>
	);
}

export function LearnScreen({ theme }: PluginScreenProps) {
	const { colors } = theme;
	const { data, error, loading, refresh } = useLearnOverview();
	const serviceUrl = data?.serviceUrl ?? null;
	const version = data?.routes.version;
	const handshake = version?.ok === true;
	const handshakeLine = version?.ok ? versionLine(version.data) : null;
	const sessions = data?.routes.sessions.ok ? sessionRows(data.routes.sessions.data) : [];
	return (
		<ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ paddingBottom: 24 }}>
			<View style={{ paddingTop: 12, paddingBottom: 10, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 4 }}>
				<View style={{ flexDirection: "row", alignItems: "center", columnGap: 8 }}>
					<Text accessibilityRole="header" style={{ flex: 1, color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>Learn</Text>
					<Pressable accessibilityRole="button" accessibilityLabel="Refresh" disabled={loading} onPress={() => void refresh()} style={{ padding: 4 }}>
						<Icon name="RefreshCw" size={15} color={loading ? colors.foregroundMuted : colors.foreground} />
					</Pressable>
				</View>
				<View style={{ flexDirection: "row", alignItems: "center", columnGap: 6 }}>
					<Dot colors={colors} ok={handshake} />
					<Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, ...mono }}>
						{handshakeLine ?? (version && !version.ok ? `handshake failed — ${version.error}${version.status !== undefined ? ` (HTTP ${String(version.status)})` : ""}` : "reading the service…")}
					</Text>
					{data ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>· fetched {clock(data.fetchedAt)}</Text> : null}
				</View>
			</View>
			{error ? (
				<Card colors={colors}>
					<Text style={{ color: colors.statusDanger, fontSize: 13, lineHeight: 18 }}>Could not read the learn service. {error}</Text>
				</Card>
			) : null}
			{!data && loading ? <Text style={{ margin: 20, color: colors.foregroundMuted, fontSize: 12 }}>Reading the learn service…</Text> : null}
			{data ? (
				<>
					<NewConversationCard colors={colors} serviceUrl={serviceUrl} onMinted={() => void refresh()} />
					<RouteCard colors={colors} title="Graph" result={data.routes.graph} />
					<RouteCard colors={colors} title="Growth" result={data.routes.growth} />
					<Card colors={colors} title="Sessions">
						{data.routes.sessions.ok ? (
							sessions.length ? (
								<View style={{ gap: 6 }}>
									{sessions.map((row) => (
										<SessionRowLine key={row.id} colors={colors} row={row} />
									))}
								</View>
							) : (
								<Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>No sessions yet — mint the first one above.</Text>
							)
						) : (
							<RouteErrorLine colors={colors} result={data.routes.sessions} />
						)}
					</Card>
					<RouteCard colors={colors} title="Spend" result={data.routes.spend} />
					<TutorCard colors={colors} result={data.routes.tutor} />
					<OpenSessionViewCard colors={colors} serviceUrl={serviceUrl} />
				</>
			) : null}
		</ScrollView>
	);
}

// The sidebar's Learn flag: the GraduationCap and "Learn".
export function LearnSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
	return <SidebarRow icon="GraduationCap" label="Learn" active={currentScreen?.screenId === LEARN_SCREEN_ID} onPress={() => openScreen({ screenId: LEARN_SCREEN_ID })} />;
}
