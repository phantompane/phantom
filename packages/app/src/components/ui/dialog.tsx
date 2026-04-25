import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Dialog({
  children,
  onOpenChange,
  open,
}: {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close dialog"
        className="absolute inset-0 bg-[var(--surface-overlay)]"
        onClick={() => onOpenChange(false)}
        type="button"
      />
      {children}
    </div>
  );
}

export function DialogContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative z-10 grid w-full max-w-md gap-4 rounded-[var(--radius-lg)] border border-border bg-card p-5 text-card-foreground shadow-[var(--shadow-lg)]",
        className,
      )}
      role="dialog"
      {...props}
    />
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-1.5", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn(
        "text-[length:var(--font-size-xl)] font-semibold leading-none",
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "text-[length:var(--font-size-md)] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex justify-end gap-2", className)} {...props} />;
}
