import { saveAs } from "file-saver";

export type SaveScriptResult = "saved" | "shared" | "cancelled" | "unavailable";

/**
 * Saves a script file: a download on a fine pointer, the system share sheet on
 * a coarse one (iOS cannot save a Blob download to Files from a PWA). A share
 * rejection other than the user cancelling (AbortError) is rethrown.
 */
export async function saveScriptFile({
  filename,
  body,
  type,
}: {
  filename: string;
  body: string;
  type: string;
}): Promise<SaveScriptResult> {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (!coarse) {
    saveAs(new Blob([body], { type }), filename);
    return "saved";
  }
  // Checked before the File is built: without file sharing nothing is saved,
  // and the caller points the user at Copy script instead.
  if (
    typeof File === "undefined" ||
    typeof navigator.canShare !== "function" ||
    typeof navigator.share !== "function"
  ) {
    return "unavailable";
  }
  const file = new File([body], filename, { type });
  if (!navigator.canShare({ files: [file] })) return "unavailable";
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    // Matched by name: a DOMException is not an Error in every realm.
    if ((error as { name?: unknown } | null)?.name === "AbortError") {
      return "cancelled";
    }
    throw error;
  }
}
