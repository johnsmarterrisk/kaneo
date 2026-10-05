import { useQuery } from "@tanstack/react-query";
import getActiveWorkspaceUsers from "@/fetchers/workspace-user/get-active-workspace-users";

type GetWorkspaceUsersRequest = {
  workspaceId?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDirection?: "asc" | "desc";
  filterField?: string;
  filterOperator?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
  filterValue?: string;
};

function useGetWorkspaceUsers({
  workspaceId,
  limit,
  offset,
  sortBy,
  sortDirection,
  filterField,
  filterOperator,
  filterValue,
}: GetWorkspaceUsersRequest) {
  return useQuery({
    queryKey: [
      "workspace-users",
      workspaceId,
      limit,
      offset,
      sortBy,
      sortDirection,
      filterField,
      filterOperator,
      filterValue,
    ],
    enabled: !!workspaceId,
    // Operon fork: the shared, paged fetch, so an actor past the first page is found
    // (see `get-active-workspace-users.ts`). The paging arguments were never forwarded.
    queryFn: async () =>
      (await getActiveWorkspaceUsers({ workspaceId: workspaceId ?? "" }))
        .members,
  });
}

export default useGetWorkspaceUsers;
