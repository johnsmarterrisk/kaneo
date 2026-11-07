// The live description text for Copy script / downloads. The mounted,
// hydrated description editor registers a reader for its task, so an export
// made inside the 700 ms save debounce carries what the user just typed; with
// no reader (or one that answers undefined) callers fall back to the cached
// task.description. Same registry shape as version-check's registerDirtyEditor.
type ScriptSourceRead = () => string | undefined;

const sources = new Map<string, ScriptSourceRead>();

/** Last registration for a task wins; the unregister removes only its own entry. */
export function registerScriptSource(
  taskId: string,
  read: ScriptSourceRead,
): () => void {
  sources.set(taskId, read);
  return () => {
    if (sources.get(taskId) === read) sources.delete(taskId);
  };
}

/** The live text, or undefined when none is registered. A throwing reader propagates. */
export function readScriptSource(taskId: string): string | undefined {
  return sources.get(taskId)?.();
}

export function resetScriptSourcesForTests(): void {
  sources.clear();
}
