import { useEffect, useRef, useState } from "react";
import { apexUrl } from "@/components/operon-switcher";

/**
 * Operon fork addition (Tables task 11, docs/fork-discipline.md row 18, spec 7.10 US5 /
 * R-F): a Stash image's preview for the gallery, lifted from Operon's
 * `app/src/files/useThumbnail.ts` (same shape: a module-level four-deep queue shared by
 * every tile, abort and revoke on unmount, an object URL once ready). The bytes come from
 * the PLATFORM's absolute origin (`${OPERON_APEX_URL}/api/files/<id>/preview`) with the
 * viewer's Operon session cookie (`credentials: "include"`), never through Initiative, so
 * Stash's own session and preview policy decide what is shown. A refusal keeps its HTTP
 * status, which the tile maps to a named placeholder — never a broken image.
 */
export const MAX_CONCURRENT_PREVIEWS = 4;

let activeCount = 0;
const waiters: Array<() => void> = [];

/** Test seam: how many previews are in flight right now. */
export function previewsInFlight() {
  return activeCount;
}

function acquireSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    let settled = false;
    const grant = () => {
      if (settled) return;
      settled = true;
      activeCount += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeCount -= 1;
        const next = waiters.shift();
        if (next) next();
      });
    };
    signal.addEventListener(
      "abort",
      () => {
        if (settled) return;
        settled = true;
        const i = waiters.indexOf(grant);
        if (i !== -1) waiters.splice(i, 1);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
    if (activeCount < MAX_CONCURRENT_PREVIEWS) grant();
    else waiters.push(grant);
  });
}

export function stashPreviewUrl(fileId: string) {
  return `${apexUrl()}/api/files/${encodeURIComponent(fileId)}/preview`;
}

/** The placeholder for a refused preview (spec 7.10): never a broken image. */
export function previewPlaceholder(status: number): string {
  switch (status) {
    case 410:
      return "Removed from Stash";
    case 415:
      return "Not an image";
    case 413:
      return "Too large to preview";
    case 401:
      return "Sign in to Operon to see images";
    default:
      return "Image unavailable";
  }
}

export type StashThumbnail =
  | { status: "idle" | "loading"; url: null; httpStatus: null }
  | { status: "ready"; url: string; httpStatus: 200 }
  | { status: "error"; url: null; httpStatus: number };

export function useStashThumbnail(
  fileId: string | null,
  enabled: boolean,
): StashThumbnail {
  const [state, setState] = useState<StashThumbnail>({
    status: "idle",
    url: null,
    httpStatus: null,
  });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !fileId) {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
      setState({ status: "idle", url: null, httpStatus: null });
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState({ status: "loading", url: null, httpStatus: null });
    void (async () => {
      let release: (() => void) | null = null;
      try {
        release = await acquireSlot(controller.signal);
        const res = await fetch(stashPreviewUrl(fileId), {
          credentials: "include",
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: "error", url: null, httpStatus: res.status });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setState({ status: "ready", url: objectUrl, httpStatus: 200 });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (cancelled) return;
        // A network failure (platform down, CORS refused) has no status: "Image unavailable".
        setState({ status: "error", url: null, httpStatus: 0 });
      } finally {
        release?.();
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [enabled, fileId]);

  return state;
}

/** Latches true the first time the element is on screen (lazy previews). */
export function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setInView(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);
  return [ref, inView] as const;
}
