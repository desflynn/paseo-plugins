// The machine tag Des sees on the Everything view: Paseo host labels are
// "korolev", "dgx-spark", "ideapad", so the first three letters read as KOR,
// DGX, IDE. Rename a host in Paseo and the tag follows.
export function shortLabel(label: string): string {
  const letters = label.replace(/[^A-Za-z0-9]/g, "");
  if (!letters) return "?";
  return letters.slice(0, 3).toUpperCase();
}

// A host's colour is a per-host setting in Paseo: `appearance.color`, one of
// "none" or ten identity colours. "none" renders the theme's muted foreground.
// These are Paseo's own identity FOREGROUND tables (packages/app/src/styles/
// identity-colors.ts, IDENTITY_FOREGROUND_DARK/LIGHT), copied rather than
// invented: the plugin API does not carry a host's colour yet.
export type IdentityColor = "violet" | "sky" | "emerald" | "orange" | "pink" | "indigo" | "teal" | "red" | "amber" | "blue";

const IDENTITY_DARK: Record<IdentityColor, string> = {
  violet: "#a392d5", sky: "#6aa6ce", emerald: "#6cae96", orange: "#cc8f64", pink: "#d87da3",
  indigo: "#9299d5", teal: "#6cacab", red: "#d88381", amber: "#b29d64", blue: "#7ba1d5",
};

const IDENTITY_LIGHT: Record<IdentityColor, string> = {
  violet: "#6d49b5", sky: "#3d6985", emerald: "#3e6e5d", orange: "#845838", pink: "#974168",
  indigo: "#5251c2", teal: "#3e6d6c", red: "#9c4243", amber: "#716239", blue: "#39649e",
};

// Des's palette, by machine (27 Oct): MS plain, KLV hot pink, DGX green,
// ideaPad orange, G5 blue, TP purple. Used only when a host carries no colour
// of its own, which is what happens after a daemon upgrade drops the setting.
// It is a fallback for a lost store, not a replacement for the real setting.
const BY_MACHINE: Array<[RegExp, IdentityColor]> = [
  [/^(klv|korolev)/i, "pink"],
  [/^(ip|ideapad)/i, "orange"],
  [/^(dgx)/i, "emerald"],
  [/^(g5|pcg5)/i, "blue"],
  [/^(tp|thinkpad)/i, "violet"],
];

export function machineColor(label: string): IdentityColor | undefined {
  for (const [pattern, color] of BY_MACHINE) if (pattern.test(label.trim())) return color;
  return undefined;
}

// The tint for a host's colour name, or undefined when the host has no colour
// ("none", missing, or a name Paseo does not know) and the caller should use
// the theme's muted foreground.
export function identityTint(color: string | undefined | null, scheme: "dark" | "light" = "dark"): string | undefined {
  if (!color || color === "none") return undefined;
  const table = scheme === "light" ? IDENTITY_LIGHT : IDENTITY_DARK;
  return table[color as IdentityColor];
}
