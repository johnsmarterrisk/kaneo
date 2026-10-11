import { ChevronLeft, Folder, Image as ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { apexUrl } from "@/components/operon-switcher";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { previewPlaceholder, useStashThumbnail } from "./use-stash-thumbnail";

/**
 * Operon fork addition (Tables task 11, docs/fork-discipline.md row 18, spec 7.10 / R-F): an
 * image column's editor — a text input that takes a pasted Stash link (or file id), "Choose
 * from Stash" (a dialog over Stash's own `GET /api/files/list?parentId=…` on the platform's
 * absolute origin with the viewer's Operon session, listing folders and `image/*` files
 * only), and a small preview of the current choice. The browser only proposes: every
 * saved image is checked server-side against Stash's preview policy (spec 7.6).
 */
export type StashNode = {
  id: string;
  parentId: string | null;
  name: string;
  kind: "file" | "folder" | string;
  mime: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bare Stash file id, or a pasted link ending `/#/files/<id>` (as the server reads it). */
export function stashFileId(value: string): string | null {
  const trimmed = value.trim();
  if (UUID.test(trimmed)) return trimmed;
  const match = /\/#\/files\/([^/?#]+)\/?$/.exec(trimmed);
  return match?.[1] && UUID.test(match[1]) ? match[1] : null;
}

/** Folders and image files only, folders first (the list's own order otherwise). */
export function pickable(nodes: StashNode[]): StashNode[] {
  const folders = nodes.filter((n) => n.kind === "folder");
  const images = nodes.filter(
    (n) => n.kind === "file" && (n.mime ?? "").startsWith("image/"),
  );
  return [...folders, ...images];
}

export async function listStash(parentId: string | null): Promise<StashNode[]> {
  const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : "";
  const res = await fetch(`${apexUrl()}/api/files/list${query}`, {
    credentials: "include",
  });
  if (res.status === 401) throw new Error("Sign in to Operon to see Stash");
  if (!res.ok) throw new Error(`Stash could not be listed (${res.status})`);
  const body = (await res.json()) as { nodes?: StashNode[] };
  return body.nodes ?? [];
}

export function StashPickerDialog({
  open,
  onClose,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (fileId: string) => void;
}) {
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [nodes, setNodes] = useState<StashNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parentId = trail[trail.length - 1]?.id ?? null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setNodes(null);
    setError(null);
    listStash(parentId)
      .then((list) => {
        if (!cancelled) setNodes(pickable(list));
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Stash is unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [open, parentId]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose from Stash</DialogTitle>
          <DialogDescription>
            {trail.length === 0
              ? "Stash"
              : ["Stash", ...trail.map((t) => t.name)].join(" / ")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-80 flex-col overflow-y-auto px-6 pb-4">
          {trail.length > 0 && (
            <button
              type="button"
              onClick={() => setTrail((t) => t.slice(0, -1))}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/60"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
          )}
          {error && <p className="py-2 text-sm text-destructive">{error}</p>}
          {!error && nodes === null && (
            <p className="py-2 text-sm text-muted-foreground">Loading…</p>
          )}
          {nodes?.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">
              No folders or images here.
            </p>
          )}
          {nodes?.map((node) =>
            node.kind === "folder" ? (
              <button
                key={node.id}
                type="button"
                onClick={() =>
                  setTrail((t) => [...t, { id: node.id, name: node.name }])
                }
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/60"
              >
                <Folder className="h-4 w-4 text-muted-foreground" />
                {node.name}
              </button>
            ) : (
              <button
                key={node.id}
                type="button"
                onClick={() => {
                  onChoose(node.id);
                  onClose();
                }}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/60"
              >
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                {node.name}
              </button>
            ),
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function StashImageField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const fileId = stashFileId(value);
  const thumb = useStashThumbnail(fileId, Boolean(fileId));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          placeholder="Paste a Stash link"
          className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-card-foreground"
          value={value}
          onChange={(e) => onChange(e.target.value || null)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          Choose from Stash
        </Button>
      </div>
      {thumb.status === "ready" && (
        <img
          src={thumb.url}
          alt="Chosen from Stash"
          className="h-24 w-24 rounded border border-border object-cover"
        />
      )}
      {thumb.status === "error" && (
        <span className="text-xs text-muted-foreground">
          {previewPlaceholder(thumb.httpStatus)}
        </span>
      )}
      <StashPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        onChoose={(fileId) => onChange(fileId)}
      />
    </div>
  );
}
