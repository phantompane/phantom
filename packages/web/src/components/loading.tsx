import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn("size-4 animate-spin", className)}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-gray-200)]",
        className,
      )}
    />
  );
}

export function InlineLoading({
  className,
  label,
}: {
  className?: string;
  label: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]",
        className,
      )}
      role="status"
    >
      <LoadingSpinner className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}

export function RoutePending() {
  return (
    <div
      className="flex h-screen min-h-0 bg-[var(--surface-window)] text-[var(--text-primary)]"
      role="status"
    >
      <aside className="hidden w-[var(--layout-sidebar-width)] shrink-0 border-r border-sidebar-border bg-sidebar p-3 md:block">
        <div className="mb-5 flex min-h-[calc(var(--layout-topbar-height)-24px)] items-center gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <ProjectListSkeleton />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--surface-panel)]">
        <header className="flex min-h-[var(--layout-topbar-height)] items-center gap-3 border-b border-border px-4">
          <Skeleton className="size-8" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </header>
        <div className="min-h-0 flex-1 px-4 py-4">
          <TimelineSkeleton />
        </div>
      </main>
    </div>
  );
}

export function ProjectListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="space-y-1.5" key={index}>
          <div className="flex h-8 items-center gap-2 px-2">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="h-3.5 w-32" />
          </div>
          {index < 2 && <WorktreeListSkeleton />}
        </div>
      ))}
    </div>
  );
}

export function WorktreeListSkeleton() {
  return (
    <div className="ml-4 space-y-1 border-l border-sidebar-border pl-4">
      {Array.from({ length: 2 }, (_, index) => (
        <div className="flex h-7 items-center gap-2" key={index}>
          <Skeleton className="size-3.5 shrink-0" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

export function TimelineSkeleton() {
  return (
    <div className="mx-auto flex max-w-[var(--layout-max-content-width)] flex-col gap-3">
      <MessageSkeleton align="right" />
      <MessageSkeleton align="left" lines={4} />
      <MessageSkeleton align="right" lines={2} />
      <MessageSkeleton align="left" lines={3} />
    </div>
  );
}

export function ActivityCard({
  children,
  label,
}: {
  children?: ReactNode;
  label: string;
}) {
  return (
    <article
      className="mr-auto flex max-w-[82%] items-start gap-3 rounded-[var(--radius-lg)] border border-border bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-xs)]"
      role="status"
    >
      <LoadingSpinner className="mt-0.5 text-[var(--semantic-info-fg)]" />
      <div className="min-w-0">
        <p className="text-[length:var(--font-size-md)] font-medium">{label}</p>
        {children && (
          <div className="mt-1 text-[length:var(--font-size-xs)] text-muted-foreground">
            {children}
          </div>
        )}
      </div>
    </article>
  );
}

function MessageSkeleton({
  align,
  lines = 3,
}: {
  align: "left" | "right";
  lines?: number;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border px-4 py-3 shadow-[var(--shadow-xs)]",
        align === "right"
          ? "ml-auto w-[min(78%,34rem)] border-transparent bg-[var(--color-gray-900)]/10"
          : "mr-auto w-[min(82%,42rem)] border-border bg-card",
      )}
    >
      <div className="space-y-2">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton
            className={cn("h-3", index === lines - 1 ? "w-2/3" : "w-full")}
            key={index}
          />
        ))}
      </div>
    </div>
  );
}
