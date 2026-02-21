import { useState, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useListContext,
  useNotify,
  EditButton,
  fetchUtils,
} from "react-admin";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import DragHandleIcon from "@mui/icons-material/DragHandle";

interface Column {
  source: string;
  label?: string;
}

interface SortableListProps {
  columns: Column[];
  resource: string;
}

const SortableRow = ({
  id,
  record,
  columns,
}: {
  id: number;
  record: any;
  columns: Column[];
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        px: 2,
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: isDragging ? "action.hover" : "background.paper",
        "&:hover": { bgcolor: "action.hover" },
        cursor: "default",
      }}
    >
      <IconButton
        size="small"
        {...attributes}
        {...listeners}
        sx={{ cursor: "grab", "&:active": { cursor: "grabbing" } }}
      >
        <DragHandleIcon fontSize="small" sx={{ color: "text.secondary" }} />
      </IconButton>
      {columns.map((col) => (
        <Typography
          key={col.source}
          variant="body2"
          sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {record[col.source] ?? "—"}
        </Typography>
      ))}
      <EditButton record={record} />
    </Box>
  );
};

const API_URL = "/api/admin";

const httpClient = (url: string, options: fetchUtils.Options = {}) => {
  const token = localStorage.getItem("accessToken");
  const headers = new Headers(options.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetchUtils.fetchJson(url, { ...options, headers });
};

export const SortableList = ({ columns, resource }: SortableListProps) => {
  const { data, isLoading } = useListContext();
  const notify = useNotify();
  const [items, setItems] = useState<any[] | null>(null);

  // Use data from list context, but allow local reordering
  const displayItems = items ?? data ?? [];

  // Reset local state when data changes from server
  const [lastDataIds, setLastDataIds] = useState<string>("");
  const currentDataIds = (data ?? []).map((d: any) => d.id).join(",");
  if (currentDataIds && currentDataIds !== lastDataIds && !items) {
    setLastDataIds(currentDataIds);
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const currentItems = items ?? data ?? [];
      const oldIndex = currentItems.findIndex((item: any) => item.id === active.id);
      const newIndex = currentItems.findIndex((item: any) => item.id === over.id);

      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(currentItems, oldIndex, newIndex);
      setItems(reordered);

      // Persist new order to backend
      try {
        const ids = reordered.map((item: any) => item.id);
        await httpClient(`${API_URL}/${resource}/reorder`, {
          method: "PUT",
          body: JSON.stringify({ ids }),
        });
        // Visual reorder provides immediate feedback; no notification needed
      } catch (error: any) {
        notify(`Error: ${error.message}`, { type: "error" });
        setItems(null); // Reset to server state
      }
    },
    [items, data, resource, notify]
  );

  if (isLoading) return null;

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          px: 2,
          py: 1,
          bgcolor: "grey.50",
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Box sx={{ width: 34 }} /> {/* Drag handle spacer */}
        {columns.map((col) => (
          <Typography
            key={col.source}
            variant="caption"
            sx={{ flex: 1, fontWeight: 600, textTransform: "uppercase", color: "text.secondary" }}
          >
            {col.label || col.source}
          </Typography>
        ))}
        <Box sx={{ width: 64 }} /> {/* Edit button spacer */}
      </Box>

      {/* Sortable rows */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={displayItems.map((item: any) => item.id)} strategy={verticalListSortingStrategy}>
          {displayItems.map((record: any) => (
            <SortableRow key={record.id} id={record.id} record={record} columns={columns} />
          ))}
        </SortableContext>
      </DndContext>
    </Box>
  );
};
