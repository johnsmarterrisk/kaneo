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

type MembersPage = NonNullable<
  Awaited<ReturnType<typeof authClient.organization.listMembers>>["data"]
>;

async function getActiveWorkspaceUsers({
  workspaceId,
}: GetActiveWorkspaceUsersRequest): Promise<MembersPage> {
  const members: MembersPage["members"] = [];
  const seen = new Set<string>();
  let total = 0;

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

    let added = 0;
    for (const member of data.members) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      members.push(member);
      added += 1;
    }
    total = data.total;

    if (data.members.length < WORKSPACE_MEMBERS_PAGE_SIZE) break;
    // A full page of rows already seen means the server ignored the offset; stop loudly
    // rather than loop forever or hand back a list that only looks complete.
    if (added === 0) {
      throw new Error("Workspace member paging did not advance");
    }
  }

  return { members, total };
}

export default getActiveWorkspaceUsers;
