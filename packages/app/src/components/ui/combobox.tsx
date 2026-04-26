import { Check, ChevronsUpDown, Search } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Input } from "./input";

export interface ComboboxOption {
  description?: string;
  disabled?: boolean;
  keywords?: string[];
  label: string;
  value: string;
}

export interface ComboboxProps {
  "aria-label": string;
  align?: "end" | "start";
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  icon?: ReactNode;
  onQueryChange?: (query: string) => void;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder: string;
  query?: string;
  searchPlaceholder?: string;
  shouldFilter?: boolean;
  side?: "bottom" | "top";
  triggerClassName?: string;
  value?: string | null;
}

export function Combobox({
  "aria-label": ariaLabel,
  align = "start",
  className,
  disabled = false,
  emptyMessage = "No results",
  icon,
  onQueryChange,
  onValueChange,
  options,
  placeholder,
  query,
  searchPlaceholder = "Search",
  shouldFilter = true,
  side = "bottom",
  triggerClassName,
  value,
}: ComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(-1);
  const [internalQuery, setInternalQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const searchQuery = query ?? internalQuery;
  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    if (!shouldFilter || !searchQuery.trim()) {
      return options;
    }
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return options.filter((option) => {
      const searchableText = [
        option.label,
        option.description,
        ...(option.keywords ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [options, searchQuery, shouldFilter]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen && query === undefined) {
      setInternalQuery("");
    }
  }, [isOpen, query]);

  useEffect(() => {
    if (!isOpen) {
      setActiveOptionIndex(-1);
      return;
    }
    setActiveOptionIndex(getNextEnabledIndex(filteredOptions, -1, 1));
  }, [filteredOptions, isOpen]);

  function updateQuery(nextQuery: string) {
    if (onQueryChange) {
      onQueryChange(nextQuery);
    } else {
      setInternalQuery(nextQuery);
    }
  }

  function selectOption(option: ComboboxOption) {
    if (option.disabled) {
      return;
    }
    onValueChange(option.value);
    setIsOpen(false);
    updateQuery("");
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveOptionIndex((current) =>
        getNextEnabledIndex(filteredOptions, current, 1),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveOptionIndex((current) =>
        getNextEnabledIndex(filteredOptions, current, -1),
      );
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveOptionIndex(getNextEnabledIndex(filteredOptions, -1, 1));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveOptionIndex(
        getNextEnabledIndex(filteredOptions, filteredOptions.length, -1),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeOptionIndex >= 0) {
        const option = filteredOptions[activeOptionIndex];
        if (!option) {
          return;
        }
        selectOption(option);
      }
    }
  }

  return (
    <div className={cn("relative min-w-0", className)} ref={rootRef}>
      <button
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-8 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-input bg-[var(--surface-card)] px-2.5 text-[length:var(--font-size-sm)] font-medium text-[var(--text-secondary)] shadow-[var(--shadow-xs)] outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:shadow-[var(--state-focus-ring)] disabled:pointer-events-none disabled:opacity-[var(--opacity-disabled)]",
          triggerClassName,
        )}
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        role="combobox"
        type="button"
      >
        {icon}
        <span className="min-w-0 truncate">
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-[var(--icon-color-muted)]" />
      </button>
      {isOpen && (
        <div
          className={cn(
            "absolute z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-md)] border border-border bg-popover text-popover-foreground shadow-[var(--shadow-md)]",
            side === "top" ? "bottom-full mb-1" : "top-full mt-1",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-divider)] px-2 py-2">
            <Search className="size-3.5 shrink-0 text-[var(--icon-color-muted)]" />
            <Input
              aria-activedescendant={
                activeOptionIndex >= 0
                  ? `${listboxId}-option-${activeOptionIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-controls={listboxId}
              autoFocus
              className="h-7 border-0 bg-transparent px-0 py-0 shadow-none focus-visible:shadow-none"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <div
            className="max-h-64 overflow-y-auto p-1"
            id={listboxId}
            role="listbox"
          >
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-3 text-[length:var(--font-size-sm)] text-[var(--text-tertiary)]">
                {emptyMessage}
              </div>
            ) : (
              filteredOptions.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeOptionIndex;
                return (
                  <button
                    aria-selected={isSelected}
                    className={cn(
                      "flex w-full min-w-0 items-start gap-2 rounded-[var(--radius-sm)] px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:shadow-[var(--state-focus-ring)] disabled:pointer-events-none disabled:opacity-[var(--opacity-disabled)]",
                      (isActive || isSelected) &&
                        "bg-[var(--state-selected-bg)]",
                    )}
                    disabled={option.disabled}
                    id={`${listboxId}-option-${index}`}
                    key={option.value}
                    onClick={() => selectOption(option)}
                    onMouseEnter={() => setActiveOptionIndex(index)}
                    role="option"
                    type="button"
                  >
                    <Check
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0 text-[var(--icon-color-active)]",
                        !isSelected && "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block truncate text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getNextEnabledIndex(
  options: ComboboxOption[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) {
    return -1;
  }

  let nextIndex = currentIndex;
  for (let offset = 0; offset < options.length; offset += 1) {
    nextIndex = (nextIndex + direction + options.length) % options.length;
    if (!options[nextIndex]?.disabled) {
      return nextIndex;
    }
  }
  return -1;
}
