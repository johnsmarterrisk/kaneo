import { useQuery } from "@tanstack/react-query";
import useAuth from "@/components/providers/auth-provider/hooks/use-auth";
import getActiveWorkspaceUsers from "@/fetchers/workspace-user/get-active-workspace-users";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";

export const useGetActiveWorkspaceUser = () => {
  const { user } = useAuth();
  const { data: workspace } = useActiveWorkspace();

  return useQuery({
    queryKey: ["workspace-user", "active", workspace?.id, user?.id],
    enabled: !!workspace?.id && !!user?.id,
    // Operon fork: the shared, paged fetch, so the caller's own membership is found even
    // when it is not on the first page (see `get-active-workspace-users.ts`).
    queryFn: async () => {
      const { members } = await getActiveWorkspaceUsers({
        workspaceId: workspace?.id ?? "",
      });
      return members.find((member) => member.userId === user?.id) ?? null;
    },
  });
};
