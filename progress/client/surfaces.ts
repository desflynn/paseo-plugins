import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ViewStyle } from "react-native";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// The 0-255 channels of a #rgb/#rrggbb or rgb() color, or null when unreadable.
function parseRgb(color: string): number[] | null {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d) : hex[1].match(/../g)!;
    return digits.map((d) => parseInt(d, 16));
  }
  const fn = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  return fn ? fn.slice(1, 4).map(Number) : null;
}

// Relative luminance of a color, or null when unreadable.
function luminance(color: string): number | null {
  const rgb = parseRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isLight(colors: Colors): boolean | null {
  const value = luminance(colors.surface0);
  return value === null ? null : value > 0.4;
}

// Paseo's sidebar tone, which the plugin theme does not pass on: surface0 stepped
// down by the ratio Paseo's own themes use (about 0.84 dark, 0.96 light).
export function sidebarTone(colors: Colors): string {
  const rgb = parseRgb(colors.surface0);
  if (!rgb) return colors.surface0;
  const factor = isLight(colors) ? 0.957 : 0.84;
  return `#${rgb.map((v) => Math.round(v * factor).toString(16).padStart(2, "0")).join("")}`;
}

// A 1px ring just inside an image: pure black or white at 10%, never a tinted gray.
export function imageOutline(colors: Colors): { borderWidth: number; borderColor: string } {
  return { borderWidth: 1, borderColor: isLight(colors) === false ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)" };
}

// Depth for cards and bordered buttons: a transparent ring plus lift in light
// themes, one white ring in dark ones. Dividers and state borders stay borders.
export function raised(colors: Colors): ViewStyle {
  const light = isLight(colors);
  if (light === null) return { borderWidth: 1, borderColor: colors.border };
  return {
    boxShadow: light
      ? "0px 0px 0px 1px rgba(0, 0, 0, 0.06), 0px 1px 2px -1px rgba(0, 0, 0, 0.06), 0px 2px 4px 0px rgba(0, 0, 0, 0.04)"
      : "0px 0px 0px 1px rgba(255, 255, 255, 0.08)",
  };
}
