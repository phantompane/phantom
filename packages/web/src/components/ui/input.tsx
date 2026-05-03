import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-9 w-full min-w-0 rounded-[var(--radius-sm)] border border-input bg-[var(--surface-input)] px-3 py-1 text-[length:var(--font-size-md)] shadow-[var(--shadow-xs)] outline-none transition-[border-color,box-shadow] duration-[var(--motion-duration-fast)] placeholder:text-[var(--text-tertiary)] focus-visible:border-ring focus-visible:shadow-[var(--state-focus-ring)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[var(--opacity-disabled)]",
        className,
      )}
      {...props}
    />
  );
}
