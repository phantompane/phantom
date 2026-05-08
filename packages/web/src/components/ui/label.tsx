import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "text-[length:var(--font-size-sm)] font-medium leading-none text-foreground",
        className,
      )}
      {...props}
    />
  );
}
