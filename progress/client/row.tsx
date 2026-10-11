import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import { Pressable, Text, View, type PressableProps, type ViewStyle } from "react-native";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// The `ref` a ticket was created with (bead:<id>, gh:<repo>#<n>), as a small
// muted mono chip on its row. Read-only: it names where the work came from.
export function RefChip({ colors, ref: refValue }: { colors: Colors; ref?: string }) {
  if (!refValue) return null;
  return (
    <View style={{ alignSelf: "flex-start", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.surface2 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10, lineHeight: 14, fontFamily: "monospace" }}>{refValue}</Text>
    </View>
  );
}

// One instant tint for every pressable row, so rows that look alike respond alike.
// Each step moves one surface up; `onSurface1` rows (dialogs, the popover, the
// working ticket) start a step higher.
export function rowTint(colors: Colors, state: { hovered: boolean; pressed: boolean }, onSurface1 = false): string {
  if (onSurface1) return state.pressed ? colors.border : state.hovered ? colors.surface2 : colors.surface1;
  return state.pressed ? colors.surface2 : state.hovered ? colors.surface1 : "transparent";
}

// A full-width row that opens something. `resting` is its background at rest.
export function PressableRow({ colors, onSurface1 = false, transparentAtRest = true, style, children, ...props }: Omit<PressableProps, "style" | "children"> & {
  colors: Colors;
  onSurface1?: boolean;
  // Rows on a surface1 background rest transparent; the working ticket rests on surface1.
  transparentAtRest?: boolean;
  style?: ViewStyle;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable {...props} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={({ pressed }) => {
        const tint = rowTint(colors, { hovered, pressed }, onSurface1);
        return [style, { backgroundColor: !hovered && !pressed && transparentAtRest ? "transparent" : tint }];
      }}>
      {children}
    </Pressable>
  );
}
