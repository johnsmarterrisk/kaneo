import {
  ChevronDown,
  ChevronRight,
  FolderGit,
  GitMerge,
  GitPullRequest,
  MessageSquare,
} from "lucide-react";
import { useMemo, useState } from "react";
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
          {linksWithoutRedundantBranches.map((link) => (
            <a
              key={link.id}
              data-testid={
                isTelegraphLink(link) ? "telegraph-external-link" : undefined
              }
              href={isTelegraphLink(link) ? telegraphLinkHref(link) : link.url}
              target="_blank"
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
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
