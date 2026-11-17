import { useEffect } from "react";
import { holdLeavePrompt } from "./uploadGuard";

/** Whether the event create page holds work that leaving would lose. */
export function hasUnsavedCreateWork(input: {
  hasFolder: boolean;
  formChanged: boolean;
  selectionCount: number;
  transcriptCount: number;
  documentCount: number;
}): boolean {
  return (
    input.hasFolder ||
    input.formChanged ||
    input.selectionCount > 0 ||
    input.transcriptCount > 0 ||
    input.documentCount > 0
  );
}

/** Arms the browser's leave prompt while `armed` is true. */
export function useLeaveGuard(armed: boolean): void {
  useEffect(() => {
    if (!armed) return;
    return holdLeavePrompt();
  }, [armed]);
}
