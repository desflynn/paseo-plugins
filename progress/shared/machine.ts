// The machine tag Des sees on the Everything view: Paseo host labels are
// "korolev", "dgx-spark", "ideapad", so the first three letters read as KOR,
// DGX, IDE. Rename a host in Paseo and the tag follows.
export function shortLabel(label: string): string {
  const letters = label.replace(/[^A-Za-z0-9]/g, "");
  if (!letters) return "?";
  return letters.slice(0, 3).toUpperCase();
}

// A host's colour is a per-host setting in Paseo (host profile appearance.color,
// one of "none" or ten identity colours), and the plugin API does not expose it
// yet: PluginHostSummary carries serverId, label and status only. So the panel
// renders the host the way Paseo renders a host with no colour set, in the
// theme's muted foreground, and takes the real colour when that field lands.
