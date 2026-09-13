import {
  ChevronDown,
  ChevronRight,
  FolderGit,
  GitMerge,
  GitPullRequest,
  MessageSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GithubIcon } from "@/components/icons/github-icon";
import { apexUrl } from "@/components/operon-switcher";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ExternalLink } from "@/types/external-link";

/**
 * Operon fork addition (spec R16, task B12).
 *
 * A `telegraph` link points at a chat message in Operon's OTHER half, which is a
 * different origin from Initiative, so it cannot be a router link. Its address is the
 * deep-link route task A7 added to the Operon shell:
 * `${OPERON_APEX_URL}/#/telegraph/msg/<event id>`.
 *
 * THE STORED `url` IS DELIBERATELY IGNORED FOR THIS TYPE.
 * `POST /api/external-link` is the first writer of that column a workspace MEMBER can
 * reach, and a row written months ago against a previous domain would send a reader to
 * a host that no longer exists. `apexUrl()` is the same runtime-substituted
 * `OPERON_APEX_URL` the injected switcher navigates to (task B11), so both links in
 * this UI agree about where Telegraph lives, always. The `externalId` — the 64-hex id
 * of the Nostr event that carried the message — is the only part of the row that is
 * used, and it is percent-encoded on the way into the URL.
 */
export const TELEGRAPH_INTEGRATION_TYPE = "telegraph";

export function isTelegraphLink(link: ExternalLink) {
  // Keyed off the integration type alone, never `metadata.createdFrom`: this
  // component is fed by `useExternalLinks`, which reads `GET /api/external-link/task/
  // {taskId}` and always carries `integration: { id, type }`, and `metadata` is
  // caller-supplied on the write route while `type` is not.
  return link.integration?.type === TELEGRAPH_INTEGRATION_TYPE;
}

export function telegraphLinkHref(link: ExternalLink) {
  return `${apexUrl()}/#/telegraph/msg/${encodeURIComponent(link.externalId)}`;
}

/**
 * Operon fork addition (spec S10/S11): a Stash file link.
 *
 * `resourceType` selects the route on the apex; the stored `url` is ignored for
 * the same reason it is ignored for a message link — the apex is a runtime value.
 * The link still points at the FILE ID, and the target may have been deleted, so
 * the row resolves through `GET /files/:id/meta` and renders one of S10's three
 * states rather than claiming success.
 */
export function isFileLink(link: ExternalLink) {
  return isTelegraphLink(link) && link.resourceType === "file";
}

export function fileLinkHref(link: ExternalLink) {
  return `${apexUrl()}/#/files/${encodeURIComponent(link.externalId)}`;
}

type FileLinkPhase =
  | { phase: "loading" }
  | { phase: "live"; name: string }
  | { phase: "deleted"; name: string }
  | { phase: "unavailable" }
  | { phase: "not-found" };

function FileLinkRow({ link }: { link: ExternalLink }) {
  const [state, setState] = useState<FileLinkPhase>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    // `attempt` is the retry token: the Retry button bumps it and this effect
    // re-asks with a fresh request.
    void attempt;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const url = `${apexUrl()}/api/files/${encodeURIComponent(link.externalId)}/meta`;
        const res = await fetch(url, { credentials: "include" });
        if (res.status === 404)
          throw Object.assign(new Error("not_found"), { code: "not_found" });
        if (!res.ok)
          throw Object.assign(new Error("unavailable"), {
            code: "unavailable",
          });
        const body = (await res.json()) as {
          name?: string;
          tombstone?: boolean;
        };
        if (!live) return;
        setState(
          body.tombstone
            ? { phase: "deleted", name: body.name ?? link.externalId }
            : {
                phase: "live",
                name: body.name ?? link.title ?? link.externalId,
              },
        );
      } catch (err) {
        if (!live) return;
        const code = (err as { code?: string }).code;
        setState(
          code === "not_found"
            ? { phase: "not-found" }
            : { phase: "unavailable" },
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [link.externalId, link.title, attempt]);

  if (state.phase === "loading") {
    return (
      <div className="py-2 px-3 text-sm text-muted-foreground">Opening…</div>
    );
  }
  if (state.phase === "deleted") {
    return (
      <div
        data-testid="file-external-link-deleted"
        className="py-2 px-3 text-sm text-muted-foreground"
      >
        “{state.name}” was deleted
      </div>
    );
  }
  if (state.phase === "unavailable") {
    return (
      <div
        data-testid="file-external-link-unavailable"
        className="py-2 px-3 text-sm text-muted-foreground flex items-center gap-2"
      >
        That file is temporarily unavailable.
        <button
          type="button"
          className="text-xs underline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  if (state.phase === "not-found") {
    return (
      <div
        data-testid="file-external-link-not-found"
        className="py-2 px-3 text-sm text-muted-foreground"
      >
        That link does not point to a file.
      </div>
    );
  }

  return (
    <a
      data-testid="file-external-link"
      href={fileLinkHref(link)}
      rel="noopener noreferrer"
      className="group flex items-center gap-3 py-2 px-3 rounded-md hover:bg-accent/50 transition-colors"
    >
      <span className="text-sm truncate flex-1 text-foreground/90 group-hover:text-foreground">
        {state.name}
      </span>
    </a>
  );
}

interface ExternalLinksAccordionProps {
  externalLinks: ExternalLink[];
  isLoading?: boolean;
}

function isGiteaResourceLink(link: ExternalLink) {
  if (link.integration?.type === "gitea") {
    return true;
  }
  const from = link.metadata?.createdFrom;
  return from === "gitea" || from === "gitea-import";
}

export function ExternalLinksAccordion({
  externalLinks,
  isLoading,
}: ExternalLinksAccordionProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(true);

  const linksWithoutRedundantBranches = useMemo(() => {
    const hasPR = externalLinks.some(
      (link) => link.resourceType === "pull_request",
    );
    if (hasPR) {
      return externalLinks.filter((link) => link.resourceType !== "branch");
    }
    return externalLinks;
  }, [externalLinks]);

  if (isLoading || linksWithoutRedundantBranches.length === 0) {
    return null;
  }

  const getStatusBadge = (link: ExternalLink) => {
    const isMerged = link.metadata?.merged === true;
    const isDraft = link.metadata?.draft === true;
    const isPR = link.resourceType === "pull_request";
    const isIssue = link.resourceType === "issue";
    const isBranch = link.resourceType === "branch";

    if (isIssue) {
      return (
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings:externalLinks.issue")}
        </span>
      );
    }

    if (isBranch) {
      return (
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings:externalLinks.branch")}
        </span>
      );
    }

    if (!isPR) return null;

    if (isMerged) {
      return (
        <span className="flex items-center gap-1 font-medium text-info-foreground text-xs">
          <GitMerge className="size-3" />
          {t("settings:externalLinks.merged")}
        </span>
      );
    }

    if (isDraft) {
      return (
        <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          <GitPullRequest className="size-3" />
          {t("settings:externalLinks.draft")}
        </span>
      );
    }

    return (
      <span className="flex items-center gap-1 font-medium text-success-foreground text-xs">
        <GitPullRequest className="size-3" />
        {t("settings:externalLinks.open")}
      </span>
    );
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-1 px-0 h-8 hover:bg-transparent"
        >
          {isOpen ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <span className="text-sm text-muted-foreground">
            {t("settings:externalLinks.resources")}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 mt-2">
          {linksWithoutRedundantBranches.map((link) =>
            isFileLink(link) ? (
              <FileLinkRow key={link.id} link={link} />
            ) : (
              <a
                key={link.id}
                data-testid={
                  isTelegraphLink(link) ? "telegraph-external-link" : undefined
                }
                href={
                  isTelegraphLink(link) ? telegraphLinkHref(link) : link.url
                }
                /*
                 * A TELEGRAPH LINK NAVIGATES THIS TAB; EVERY OTHER PROVIDER STILL OPENS
                 * A NEW ONE (Operon spec R12, decision 108).
                 *
                 * Operon's session-restore profile is `sessionStorage`
                 * (`app/src/auth/AuthContext.tsx:99,122` in the Operon repository), so it
                 * is scoped to the tab, and the restore returns early when it is absent
                 * (`AuthContext.tsx:326-330`). A `target="_blank"` tab opened from THIS
                 * document inherits no sessionStorage — the opener is the `initiative.`
                 * sibling, a different origin from the apex — so the new tab holds no
                 * profile for Operon and meets the login instead of the message.
                 * Navigating in place is what the injected switcher already relies on
                 * (`operon-switcher.tsx:242` renders its module links with no `target`):
                 * the tab showing Initiative is the tab that was showing Operon, and it
                 * still holds that origin's profile. The alternative — moving the
                 * non-secret profile into a cookie readable across the sibling hosts —
                 * widens a surface AuthContext deliberately narrowed, to buy what one
                 * attribute buys. GitHub and Gitea point at third-party hosts with no
                 * Operon session to keep, so they keep the new tab; `rel` stays on every
                 * link, because it is `noreferrer` as much as `noopener`.
                 */
                target={isTelegraphLink(link) ? undefined : "_blank"}
                rel="noopener noreferrer"
                className="group flex items-center gap-3 py-2 px-3 rounded-md hover:bg-accent/50 transition-colors"
              >
                {isTelegraphLink(link) ? (
                  <MessageSquare className="size-4 flex-shrink-0 text-muted-foreground" />
                ) : isGiteaResourceLink(link) ? (
                  <FolderGit className="size-4 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <GithubIcon className="size-4 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="text-sm truncate flex-1 text-foreground/90 group-hover:text-foreground">
                  {link.title || link.externalId}
                  {/*
                  A Telegraph externalId is a 64-hex Nostr event id, not a
                  human-facing issue number, so it is not repeated as "#<id>" —
                  that would push the title out of a 224px sidebar entirely.
                */}
                  {link.resourceType !== "branch" && !isTelegraphLink(link) && (
                    <span className="text-muted-foreground ml-2">
                      #{link.externalId}
                    </span>
                  )}
                </span>
                {getStatusBadge(link)}
              </a>
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
