import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const variants = {
  default:
    "bg-primary text-primary-foreground shadow-[var(--shadow-xs)] hover:bg-[var(--color-gray-800)]",
  destructive:
    "bg-destructive text-destructive-foreground shadow-[var(--shadow-xs)] hover:bg-[var(--color-rose-500)] focus-visible:ring-[var(--semantic-danger-border)]/40",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  outline:
    "border border-input bg-[var(--surface-card)] shadow-[var(--shadow-xs)] hover:bg-accent hover:text-accent-foreground",
  secondary:
    "bg-secondary text-secondary-foreground shadow-[var(--shadow-xs)] hover:bg-[var(--color-gray-150)]",
} as const;

const sizes = {
  default: "h-9 px-4 py-2",
  icon: "size-8",
  sm: "h-8 gap-1.5 px-3",
} as const;

export interface ButtonProps extends ComponentProps<"button"> {
  size?: keyof typeof sizes;
  variant?: keyof typeof variants;
}

export function Button({
  className,
  size = "default",
  variant = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] text-[length:var(--font-size-sm)] font-medium outline-none transition-colors duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] focus-visible:border-ring focus-visible:shadow-[var(--state-focus-ring)] disabled:pointer-events-none disabled:opacity-[var(--opacity-disabled)] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
