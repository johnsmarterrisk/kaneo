import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import CreateTableModal from "./create-table-modal";

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18): the "New table" entry
 * beside "Create project" on the workspace projects page. Shown to workspace owners and
 * admins only; the server's `requireTableAdmin` is the check of record.
 */
function NewTableAction() {
  const { isAdmin } = useWorkspacePermission();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <Button
        variant="outline"
        size="xs"
        onClick={() => setOpen(true)}
        className="gap-1"
      >
        <Plus className="w-3 h-3" />
        New table
      </Button>
      <CreateTableModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default NewTableAction;
