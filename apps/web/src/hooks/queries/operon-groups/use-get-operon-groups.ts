import { useQuery } from "@tanstack/react-query";
import getOperonGroups from "@/fetchers/operon-groups/get-operon-groups";

// The editor's group items (Operon group-mentions D10). A failed read (Operon down, a
// person outside the Operon workspace) shows no groups rather than retrying: the save
// path expands from its own fresh read, so a stale or missing list never notifies anyone.
export function useGetOperonGroups(enabled: boolean) {
  return useQuery({
    queryKey: ["operon-groups"],
    queryFn: getOperonGroups,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
