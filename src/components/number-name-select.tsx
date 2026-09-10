import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const NUMBER_NAME_OPTIONS = [
  "Appliance Repair Nationwide MIS",
  "Atlanta Georgia Appliance Repair / GD",
  "Atlanta Georgia Handyman",
  "Austin Handyman N/FB",
  "Chicago Facebook",
  "Chicago Handyman",
  "Dallas Garage Door",
  "Exterior Painting Nationwide / TV Mounting",
  "Garage Door NATIONWIDE MIS",
  "Houston Facebook ND Garage Door OP1",
  "Houston Handyman",
  "Houston Handyman OP1",
  "Indianapolis Handyman",
  "JOC HOT TUB",
  "Junk Removal Nationwide MIS",
  "Los Angeles - Handyman",
  "Los Angeles Appliance OP1",
  "Los Angeles Facebook OP1",
  "LOS ANGELES GARAGE DOOR / CLEANING / PLUMBING",
  "Los Angeles Handyman FB",
  "Max Mad",
  "Miami Appliance Repair",
  "Miami FB/ND Garage Door OP1",
  "Miami Handyman",
  "Nationwide Christmas Lights",
  "Nationwide Drywall Patch Repair",
  "Nationwide Plumbing FB / Nationwide Handyman",
  "New Jersey Handyman",
  "New York Handyman",
  "Orange County Appliance Repair",
  "Orange County Handyman OP1",
  "San Diego - Appliance Repair",
  "San Diego - Handyman",
  "San Diego Garage Door OP1",
  "San Jose Appliance Repair",
  "San Jose Handyman",
  "Santa Clarita Handyman",
  "Sliding Door",
] as const;

export function NumberNameSelect({
  value,
  onChange,
  onCommit,
  className,
  size = "default",
  placeholder = "Select number name",
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit?: (next: string) => void;
  className?: string;
  size?: "sm" | "default";
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const sizeCls = size === "sm" ? "h-8 text-[12px]" : "h-9 text-[13px]";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between font-normal",
            sizeCls,
            !value && "text-muted-foreground",
            className,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          filter={(value, search) => (value.toLowerCase().startsWith(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Search... (matches start)" className="h-9" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {/* Clear option — lets a number name be removed from the lead. */}
              <CommandItem
                value="No number name"
                onSelect={() => {
                  onChange("");
                  onCommit?.("");
                  setOpen(false);
                }}
                className="text-[12.5px] text-muted-foreground"
              >
                <Check className={cn("mr-2 h-3.5 w-3.5", !value ? "opacity-100" : "opacity-0")} />
                No number name
              </CommandItem>
              {NUMBER_NAME_OPTIONS.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={(v) => {
                    onChange(v);
                    onCommit?.(v);
                    setOpen(false);
                  }}
                  className="text-[12.5px]"
                >
                  <Check
                    className={cn("mr-2 h-3.5 w-3.5", value === opt ? "opacity-100" : "opacity-0")}
                  />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
