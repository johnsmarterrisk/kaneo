import { useQuery } from "@tanstack/react-query";
import useAuth from "@/components/providers/auth-provider/hooks/use-auth";
import getOperonGroups from "@/fetchers/operon-groups/get-operon-groups";

// The editor's group items (Operon group-mentions D10). A failed read (Operon down, a
// person outside the Operon workspace) shows no groups rather than retrying: the save
// path expands from its own fresh read, so a stale or missing list never notifies anyone.
//
// Operon review round 1, finding 5: the list is keyed by the signed-in user, so a
// same-tab account switch never shows the previous account's rows, and it is never kept
// between editors (`gcTime: 0`) nor trusted as fresh (`staleTime: 0`), so a demotion in
// Operon (which answers a guest `[]`) is seen the next time an editor opens or the window
// refocuses. A failed refresh hides the last good list instead of showing it on, and so
// does a refresh still in flight (Codex round 2): TanStack keeps the old rows until the
// request settles, so a demoted person would see them while a refocus read is pending.
export function useGetOperonGroups(enabled: boolean) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const query = useQuery({
    queryKey: ["operon-groups", userId],
    queryFn: getOperonGroups,
    enabled: enabled && userId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return {
    ...query,
    data: query.isError || query.isFetching ? undefined : query.data,
  };
}
