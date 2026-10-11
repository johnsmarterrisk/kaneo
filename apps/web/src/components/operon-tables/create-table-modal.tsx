import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import useCreateTable from "@/hooks/mutations/operon-tables/use-create-table";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import generateProjectSlug from "@/lib/generate-project-id";
import { toast } from "@/lib/toast";

// Operon fork addition (Tables, docs/fork-discipline.md row 18). English copy, like
// operon-switcher.tsx: the fork's own surfaces are not translated upstream strings.
export const NEW_TABLE_ICON = "Layout";

type CreateTableModalProps = {
  open: boolean;
  onClose: () => void;
};

function CreateTableModal({ open, onClose }: CreateTableModalProps) {
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: workspace } = useActiveWorkspace();
  const { mutateAsync, isPending } = useCreateTable();

  const handleClose = () => {
    setName("");
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !workspace?.id) return;
    try {
      // The same generated slug and default icon the project modal sends.
      const { id } = await mutateAsync({
        workspaceId: workspace.id,
        name: trimmed,
        slug: generateProjectSlug(trimmed),
        icon: NEW_TABLE_ICON,
      });
      toast.success("Table created");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate({
        to: "/dashboard/workspace/$workspaceId/project/$projectId",
        params: { workspaceId: workspace.id, projectId: id },
      });
      handleClose();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The table could not be created",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New table</DialogTitle>
          <DialogDescription>
            Starts from the Marketing asset columns: Topic, Status, Posted,
            Channel and Link.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 pb-2">
          <Input
            aria-label="Table name"
            placeholder="Table name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isPending}>
              Create table
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default CreateTableModal;
