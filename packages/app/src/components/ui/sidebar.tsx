import { PanelLeft } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ComponentProps, CSSProperties } from "react";
import { cn } from "../../lib/utils";

const SIDEBAR_KEYBOARD_SHORTCUT = "b";

interface SidebarContextValue {
  open: boolean;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  state: "collapsed" | "expanded";
  toggleSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

export function SidebarProvider({
  children,
  className,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  style,
  ...props
}: ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [_open, _setOpen] = useState(defaultOpen);
  const open = openProp ?? _open;

  const setOpen = useCallback(
    (value: boolean | ((open: boolean) => boolean)) => {
      const nextOpen = typeof value === "function" ? value(open) : value;
      onOpenChange?.(nextOpen);
      if (openProp === undefined) {
        _setOpen(nextOpen);
      }
    },
    [onOpenChange, open, openProp],
  );

  const toggleSidebar = useCallback(() => {
    setOpen((current) => !current);
  }, [setOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const contextValue = useMemo<SidebarContextValue>(
    () => ({
      open,
      setOpen,
      state: open ? "expanded" : "collapsed",
      toggleSidebar,
    }),
    [open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full bg-background text-foreground has-[[data-variant=inset]]:bg-background",
          className,
        )}
        style={
          {
            "--sidebar-width": "var(--layout-sidebar-width)",
            ...style,
          } as CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  children,
  className,
  collapsible = "offcanvas",
  variant = "sidebar",
  ...props
}: ComponentProps<"aside"> & {
  collapsible?: "none" | "offcanvas";
  variant?: "inset" | "sidebar";
}) {
  const { state } = useSidebar();
  const isOffcanvasCollapsed =
    state === "collapsed" && collapsible === "offcanvas";
  return (
    <aside
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-state={state}
      data-variant={variant}
      className={cn(
        "group/sidebar relative hidden h-svh shrink-0 flex-col overflow-hidden text-sidebar-foreground transition-[width] duration-[var(--motion-duration-normal)] ease-[var(--motion-ease-standard)] md:flex",
        isOffcanvasCollapsed && "w-0 border-r-0",
        (state === "expanded" || collapsible === "none") &&
          "w-[--sidebar-width]",
        !isOffcanvasCollapsed &&
          variant === "sidebar" &&
          "border-r border-sidebar-border bg-sidebar",
        !isOffcanvasCollapsed &&
          variant === "inset" &&
          "border-r border-sidebar-border bg-sidebar",
        className,
      )}
      {...props}
    >
      {!isOffcanvasCollapsed && (
        <div className="flex h-full min-h-0 flex-col bg-sidebar">
          {children}
        </div>
      )}
    </aside>
  );
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-[var(--layout-topbar-height)] items-center gap-2 border-b border-sidebar-border px-3 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-2",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarInset({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "relative flex min-w-0 flex-1 flex-col bg-[var(--surface-panel)]",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarTrigger({
  className,
  ...props
}: ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:shadow-[var(--state-focus-ring)] disabled:pointer-events-none disabled:opacity-[var(--opacity-disabled)]",
        className,
      )}
      onClick={toggleSidebar}
      title="Toggle sidebar"
      type="button"
      {...props}
    >
      <PanelLeft className="size-4" />
      <span className="sr-only">Toggle sidebar</span>
    </button>
  );
}

export function SidebarRail({ className, ...props }: ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      aria-label="Toggle sidebar"
      className={cn(
        "absolute inset-y-0 -right-3 z-20 hidden w-6 -translate-x-px transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-sidebar-border sm:flex",
        className,
      )}
      onClick={toggleSidebar}
      tabIndex={-1}
      type="button"
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto p-2 group-data-[state=collapsed]/sidebar:px-2",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("border-t border-sidebar-border p-3", className)}
      {...props}
    />
  );
}

export function SidebarGroup({
  className,
  ...props
}: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "relative space-y-1 group-data-[state=collapsed]/sidebar:space-y-2",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupHeader({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 group-data-[state=collapsed]/sidebar:hidden",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupLabel({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-w-0 flex-1 px-2 py-1 text-[length:var(--font-size-xs)] font-medium text-[var(--text-secondary)]",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupAction({
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--icon-color-default)] outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:shadow-[var(--state-focus-ring)]",
        className,
      )}
      type="button"
      {...props}
    />
  );
}

export function SidebarGroupContent({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div className={cn("w-full", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("space-y-1", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return <li className={cn("min-w-0", className)} {...props} />;
}

export function SidebarMenuButton({
  className,
  isActive,
  ...props
}: ComponentProps<"button"> & { isActive?: boolean }) {
  return (
    <button
      className={cn(
        "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[length:var(--font-size-sm)] outline-none transition-colors duration-[var(--motion-duration-fast)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:shadow-[var(--state-focus-ring)] group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0",
        isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarMenuSub({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      className={cn(
        "ml-4 mt-1 space-y-1 border-l border-sidebar-border pl-2 group-data-[state=collapsed]/sidebar:hidden",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarMenuSubItem({
  className,
  ...props
}: ComponentProps<"li">) {
  return <li className={cn("min-w-0", className)} {...props} />;
}

export function SidebarMenuSubButton({
  className,
  isActive,
  ...props
}: ComponentProps<"button"> & { isActive?: boolean }) {
  return (
    <button
      className={cn(
        "flex min-h-7 w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left text-[length:var(--font-size-sm)] outline-none transition-colors duration-[var(--motion-duration-fast)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:shadow-[var(--state-focus-ring)]",
        isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}
