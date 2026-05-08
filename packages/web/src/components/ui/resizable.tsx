import { GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const RESIZABLE_HANDLE_CLASS_NAME =
  "relative flex w-px shrink-0 items-center justify-center bg-sidebar-border outline-none transition-colors duration-[var(--motion-duration-fast)] after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 hover:bg-[var(--border-strong)] focus-visible:shadow-[var(--state-focus-ring)] data-[separator=active]:bg-[var(--border-strong)] [aria-orientation=horizontal]:h-px [aria-orientation=horizontal]:w-full [aria-orientation=horizontal]:after:inset-x-0 [aria-orientation=horizontal]:after:inset-y-auto [aria-orientation=horizontal]:after:top-1/2 [aria-orientation=horizontal]:after:h-3 [aria-orientation=horizontal]:after:w-full [aria-orientation=horizontal]:after:translate-x-0 [aria-orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90";

export function ResizablePanelGroup({
  className,
  ...props
}: ComponentProps<typeof Group>) {
  return <Group className={cn("min-h-0 w-full", className)} {...props} />;
}

export const ResizablePanel = Panel;

export function ResizableHandle({
  className,
  withHandle,
  ...props
}: ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}) {
  return (
    <Separator
      className={cn(RESIZABLE_HANDLE_CLASS_NAME, className)}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-5 w-3 items-center justify-center rounded-[var(--radius-xs)] border border-sidebar-border bg-[var(--surface-card)] shadow-[var(--shadow-xs)]">
          <GripVertical className="size-3 text-[var(--icon-color-muted)]" />
        </div>
      )}
    </Separator>
  );
}
