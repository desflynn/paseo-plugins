// The machine tag Des sees on the Everything view: Paseo host labels are
// "korolev", "dgx-spark", "ideapad", so the first three letters read as KOR,
// DGX, IDE. Rename a host in Paseo and the tag follows.
export function shortLabel(label: string): string {
  const letters = label.replace(/[^A-Za-z0-9]/g, "");
  if (!letters) return "?";
  return letters.slice(0, 3).toUpperCase();
}
