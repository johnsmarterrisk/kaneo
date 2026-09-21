import { useState } from "react";
import type { ProjectWithTasks } from "@/types/project";
import { ColumnDropzone } from "./column-dropzone";
import { ColumnHeader } from "./column-header";

type ColumnProps = {
  column: ProjectWithTasks["columns"][number];
  disableDragDrop?: boolean;
};

function Column({ column, disableDragDrop = false }: ColumnProps) {
  const [isDropzoneOver, setIsDropzoneOver] = useState(false);

  return (
    <div
      className={`group relative flex h-full min-h-0 w-full flex-col rounded-2xl bg-card text-card-foreground shadow-panel transition-colors duration-150 ${
        isDropzoneOver ? "ring-2 ring-ring/40" : ""
      }`}
    >
      <div className="shrink-0 border-b border-border px-4 py-2">
        <ColumnHeader column={column} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 [-webkit-overflow-scrolling:touch]">
        <ColumnDropzone
          column={column}
          disableDragDrop={disableDragDrop}
          onIsOverChange={setIsDropzoneOver}
        />
      </div>
    </div>
  );
}

export default Column;
