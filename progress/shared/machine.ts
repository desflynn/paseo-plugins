// The machine tag Des sees on the Everything view: Paseo host labels are
// "korolev", "dgx-spark", "ideapad", so the first three letters read as KOR,
// DGX, IDE. Rename a host in Paseo and the tag follows.
export function shortLabel(label: string): string {
  const letters = label.replace(/[^A-Za-z0-9]/g, "");
  if (!letters) return "?";
  return letters.slice(0, 3).toUpperCase();
}

// One colour per machine, the way Paseo's sidebar tints a host. Ours, not
// Paseo's: a label always gets the same colour on every row and every page,
// and two machines never share one while there are palette slots left.
const TINTS = ["#7aa2f7", "#e0af68", "#9ece6a", "#bb9af7", "#7dcfff", "#f7768e"] as const;

export function machineTint(label: string): string {
  // FNV-1a: small labels like MS and KLV land far apart in a six-slot palette.
  let hash = 2166136261;
  for (const letter of label.toLowerCase()) {
    hash ^= letter.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return TINTS[hash % TINTS.length];
}
