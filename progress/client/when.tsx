import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text } from "react-native";
import { formatAgo, formatClock } from "../shared/format";
import { useNarrow } from "./narrow";
import { useNowClock } from "./now";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// "Sep 27, 8:14 PM (10 h 2 min ago)", inline inside other text. A narrow
// panel shows only "10 h 2 min ago"; the ticket dialog keeps the clock time.
// The clock comes from the panel's Now context (o47.4), so When keeps counting
// on the tick without its holders carrying a `now` prop.
export function When({ colors, iso }: { colors: Colors; iso: string }) {
  const now = useNowClock();
  if (useNarrow()) return <Text>{formatAgo(iso, now)}</Text>;
  return (
    <Text>
      {formatClock(iso)} <Text style={{ color: colors.foregroundMuted, opacity: 0.7 }}>({formatAgo(iso, now)})</Text>
    </Text>
  );
}
