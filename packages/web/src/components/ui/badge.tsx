import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const variants = {
  default: "border-transparent bg-primary text-primary-foreground",
  danger:
    "border-[var(--semantic-danger-border)] bg-[var(--semantic-danger-bg)] text-[var(--semantic-danger-fg)]",
  info: "border-[var(--semantic-info-border)] bg-[var(--semantic-info-bg)] text-[var(--semantic-info-fg)]",
  outline: "border-border bg-transparent text-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  success:
    "border-[var(--semantic-success-border)] bg-[var(--semantic-success-bg)] text-[var(--semantic-success-fg)]",
  warning:
    "border-[var(--semantic-warning-border)] bg-[var(--semantic-warning-bg)] text-[var(--semantic-warning-fg)]",
} as const;

export interface BadgeProps extends ComponentProps<"span"> {
  variant?: keyof typeof variants;
}

export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-xs)] border px-2 py-0.5 text-[length:var(--font-size-xs)] font-medium whitespace-nowrap transition-colors",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
