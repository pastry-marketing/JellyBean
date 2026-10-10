import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { US_STATES, resolveUsStateCode } from "@/lib/us-states";
import { cn } from "@/lib/utils";

type StateComboboxProps = {
  value: string;
  onChange: (code: string) => void;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
};

function stateLabel(code: string) {
  const state = US_STATES.find((item) => item.code === code);
  return state ? `${state.name} (${state.code})` : "";
}

export function StateCombobox({
  value,
  onChange,
  id,
  required,
  disabled,
  className,
}: StateComboboxProps) {
  const generatedId = useId();
  const inputId = id ?? `state-${generatedId}`;
  const listboxId = `${inputId}-listbox`;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(() => stateLabel(value));
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [contentWidth, setContentWidth] = useState<number>();

  useEffect(() => {
    if (!open) setQuery(stateLabel(value));
  }, [open, value]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || normalized === stateLabel(value).toLowerCase()) return US_STATES;
    return US_STATES.filter(
      (state) =>
        state.name.toLowerCase().includes(normalized) ||
        state.code.toLowerCase().startsWith(normalized),
    );
  }, [query, value]);

  function openList() {
    if (disabled) return;
    setContentWidth(anchorRef.current?.getBoundingClientRect().width);
    setOpen(true);
    setHighlightedIndex(0);
  }

  function selectState(code: string) {
    onChange(code);
    setQuery(stateLabel(code));
    setOpen(false);
    setHighlightedIndex(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) return openList();
      setHighlightedIndex((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && open && filtered[highlightedIndex]) {
      event.preventDefault();
      selectState(filtered[highlightedIndex].code);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={inputId}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              onChange(resolveUsStateCode(nextQuery) ?? "");
              if (!open) openList();
              setHighlightedIndex(0);
            }}
            onFocus={(event) => {
              event.currentTarget.select();
              openList();
            }}
            onClick={openList}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              const exactCode = resolveUsStateCode(query);
              if (exactCode) selectState(exactCode);
            }}
            placeholder="Type a state or abbreviation"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            required={required}
            disabled={disabled}
            className={cn("pl-9", className)}
          />
        </div>
      </PopoverAnchor>
      <PopoverPrimitive.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="z-[70] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none"
        style={{ width: contentWidth }}
      >
        <div id={listboxId} role="listbox" className="max-h-[280px] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-5 text-center text-sm text-muted-foreground">
              No matching state
            </div>
          ) : (
            filtered.map((state, index) => (
              <button
                key={state.code}
                type="button"
                role="option"
                aria-selected={value === state.code}
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectState(state.code)}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm",
                  highlightedIndex === index && "bg-accent text-accent-foreground",
                )}
              >
                <span>{state.name}</span>
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  {state.code}
                  {value === state.code ? <Check className="h-4 w-4" /> : null}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverPrimitive.Content>
    </Popover>
  );
}
