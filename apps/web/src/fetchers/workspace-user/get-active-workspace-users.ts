import type { Member } from "better-auth/plugins/organization";
import { authClient } from "@/lib/auth-client";

export type GetActiveWorkspaceUsersRequest = {
  workspaceId: string;
};

// Operon fork: Better Auth's `listMembers` answers ONE page — 100 rows by default, in no
// stable order — so a workspace past 100 members silently lost people from every list
// built on it (actors shown as "Someone", the assignee menu, mentions, toolbars). This is
// the one fetch of the member list: it pages in a stable order (member `id`, ascending)
// until a short page ends it, so the list is complete at any size. better-auth 1.6.25
// honours `limit`, `offset` and `sortBy` here and applies no maximum page size.
export const WORKSPACE_MEMBERS_PAGE_SIZE = 200;

// Better Auth's client currently infers this endpoint as `any`; keep the returned
// page typed so the member hooks and their UI callers retain checked member fields.
type MembersPage = {
  members: (Member & {
    user: { id: string; name: string; email: string; image?: string | null };
  })[];
  total: number;
};

async function getActiveWorkspaceUsers({
  workspaceId,
}: GetActiveWorkspaceUsersRequest): Promise<MembersPage> {
  const members: MembersPage["members"] = [];
  const seen = new Set<string>();
  let total: number | undefined;

  for (let offset = 0; ; offset += WORKSPACE_MEMBERS_PAGE_SIZE) {
    const { data, error } = await authClient.organization.listMembers({
      query: {
        organizationId: workspaceId,
        limit: WORKSPACE_MEMBERS_PAGE_SIZE,
        offset,
        sortBy: "id",
        sortDirection: "asc",
      },
    });

    // Any failed page fails the whole list: a partial list must never pass as complete.
    if (error || !data) {
      throw new Error(error?.message || "Failed to fetch workspace users");
    }

    // A page or count that changes under offset paging cannot prove a complete list.
    // Fail the query so its callers never receive a silently incomplete result.
    if (
      !Array.isArray(data.members) ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      data.members.length > WORKSPACE_MEMBERS_PAGE_SIZE ||
      (total !== undefined && data.total !== total)
    ) {
      throw new Error("Workspace member paging returned an inconsistent page");
    }
    total = data.total;
    for (const member of data.members) {
      if (seen.has(member.id)) {
        throw new Error("Workspace member paging repeated a member");
      }
      seen.add(member.id);
      members.push(member);
    }

    if (members.length > total) {
      throw new Error("Workspace member paging exceeded the reported total");
    }
    if (data.members.length < WORKSPACE_MEMBERS_PAGE_SIZE) break;
  }

  if (members.length !== total) {
    throw new Error("Workspace member paging ended before the reported total");
  }
  return { members, total };
}

export default getActiveWorkspaceUsers;
