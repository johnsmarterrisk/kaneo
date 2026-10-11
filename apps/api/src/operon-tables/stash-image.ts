import { HTTPException } from "hono/http-exception";
import { operonS2SChannel } from "../auth";

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18, spec 7.6 / R-F): an image
 * column stores a Stash file UUID, and the server asks Operon — on the signed in-network
 * channel, with row 15's 2 s abort and `redirect: "manual"` — whether the writer may
 * reference that file as an image. Operon applies its own preview policy (not found,
 * deleted, not an image, too large) and the writer's identity. It FAILS CLOSED: no
 * channel, a timeout or any unexpected answer is 503, never a silent accept.
 */
export const STASH_IMAGE_TIMEOUT_MS = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STASH_LINK = /\/#\/files\/([0-9a-f-]{36})\/?$/i;

/** A bare UUID, or a pasted Stash link ending `/#/files/<uuid>`, as the bare UUID. */
export function normalizeStashFileId(value: string): string | null {
  const trimmed = value.trim();
  if (UUID.test(trimmed)) return trimmed.toLowerCase();
  const link = STASH_LINK.exec(trimmed);
  if (link?.[1] && UUID.test(link[1])) return link[1].toLowerCase();
  return null;
}

const REFUSALS: Record<number, string> = {
  403: "no_access",
  404: "not_found",
  410: "deleted",
  413: "too_large",
  415: "not_image",
};

function imageRefused(reason: string): never {
  throw new HTTPException(422, {
    res: Response.json(
      {
        error: "image_refused",
        reason,
        message: "That image cannot be used from Stash",
      },
      { status: 422 },
    ),
  });
}

function unavailable(): never {
  throw new HTTPException(503, {
    res: Response.json(
      {
        error: "image_check_unavailable",
        message: "Stash could not be checked; try again shortly",
      },
      { status: 503 },
    ),
  });
}

/**
 * Normalise and check one image value. Returns the UUID to store; throws 422
 * `image_refused` (with the reason) or 503 `image_check_unavailable`.
 */
export async function checkStashImage(
  userId: string,
  value: string,
): Promise<string> {
  const fileId = normalizeStashFileId(value);
  if (!fileId) imageRefused("not_a_stash_file");

  const channel = operonS2SChannel();
  if (!channel) {
    console.error("[operon] tables.image_check_failed", {
      reason: "unconfigured",
    });
    unavailable();
  }

  const body = JSON.stringify({
    kaneoUserId: userId,
    fileId,
    timestamp: new Date().toISOString(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STASH_IMAGE_TIMEOUT_MS);
  let status: number;
  try {
    const response = await fetch(`${channel.base}/internal/kaneo/stash-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operon-Signature": channel.sign(body),
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    status = response.status;
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    console.error("[operon] tables.image_check_failed", {
      reason: controller.signal.aborted ? "timeout" : "unreachable",
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    unavailable();
  } finally {
    clearTimeout(timer);
  }

  if (status === 200) return fileId;
  const reason = REFUSALS[status];
  if (reason) imageRefused(reason);
  console.error("[operon] tables.image_check_failed", {
    reason: "platform_status",
    status,
  });
  unavailable();
}
