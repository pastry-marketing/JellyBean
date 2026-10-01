import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/confirm-dialog-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  SERVICE_CATEGORIES,
  filterServiceCategories,
  isExistingService,
} from "@/data/service-options";
import {
  listServiceAssignments,
  removeServiceAssignment,
  upsertServiceAssignments,
  type ServiceAssignmentRow,
} from "@/lib/lead-assignment.functions";
import { listCsTeam, type CsTeamMember } from "@/lib/cs-team.functions";
import {
  mergeServiceSelections,
  normalizeLeadService,
  toServiceSelection,
  type ServiceSelection,
} from "@/lib/service-assignment";
import { cn } from "@/lib/utils";

type ServiceListItem =
  | {
      type: "service";
      category: string;
      service: string;
    }
  | {
      type: "custom";
      value: string;
    };

export function ServiceAssignmentTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(listServiceAssignments);
  const teamFn = useServerFn(listCsTeam);
  const removeFn = useServerFn(removeServiceAssignment);

  const rowsQ = useQuery({
    queryKey: ["service-assignments"],
    queryFn: () => listFn(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const teamQ = useQuery({
    queryKey: ["cs-team-for-assignment"],
    queryFn: () => teamFn(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceAssignmentRow | null>(null);

  const removeMut = useMutation({
    mutationFn: (service_key: string) => removeFn({ data: { service_key } }),
    onSuccess: () => {
      toast.success("Assignment removed");
      qc.invalidateQueries({ queryKey: ["service-assignments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleRemove(row: ServiceAssignmentRow) {
    const ok = await confirmDialog({
      title: `Remove ${row.service_name} assignment?`,
      description: `Future ${row.service_name} leads will no longer use this service assignment. They may still route through a matching state assignment. Existing leads will not be reassigned.`,
      confirmText: "Remove",
      tone: "destructive",
    });
    if (!ok) return;
    removeMut.mutate(row.service_key);
  }

  return (
    <div className="glass-card p-4 md:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {rowsQ.isLoading
            ? "Loading service assignments..."
            : rowsQ.isError
              ? "Unable to load service assignments"
              : `${rowsQ.data?.length ?? 0} services assigned`}
          {!rowsQ.isLoading && rowsQ.isFetching ? (
            <span className="ml-2 inline-flex items-center text-xs">
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Refreshing
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          Assign Services
        </Button>
      </div>

      {rowsQ.isError ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <div>
            <div className="font-semibold text-destructive">Failed to load service assignments</div>
            <div className="mt-1 break-words text-xs text-muted-foreground">
              {(rowsQ.error as Error)?.message ?? "Unknown error"}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => rowsQ.refetch()}
            disabled={rowsQ.isFetching}
          >
            {rowsQ.isFetching ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Retry
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SERVICE</TableHead>
                <TableHead>CATEGORY</TableHead>
                <TableHead>ASSIGNED CS USER</TableHead>
                <TableHead className="text-right">TOTAL LEADS</TableHead>
                <TableHead className="text-right">ACTIONS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowsQ.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Loading...
                  </TableCell>
                </TableRow>
              ) : (rowsQ.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No services assigned yet.
                  </TableCell>
                </TableRow>
              ) : (
                rowsQ.data!.map((row) => (
                  <TableRow key={row.service_key}>
                    <TableCell className="font-medium">{row.service_name}</TableCell>
                    <TableCell>
                      {row.service_category ? (
                        <Badge variant="secondary" className="text-[10px]">
                          {row.service_category}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Custom</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{row.cs_user_name ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{row.cs_user_email ?? ""}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.total_leads ?? 0}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(row);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="mr-1 h-3.5 w-3.5" />
                          Change
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRemove(row)}
                          disabled={removeMut.isPending}
                          aria-label={`Delete ${row.service_name} assignment`}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <ServiceAssignmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        team={teamQ.data ?? []}
        editing={editing}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["service-assignments"] });
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

function ServiceAssignmentDialog({
  open,
  onOpenChange,
  team,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  team: CsTeamMember[];
  editing: ServiceAssignmentRow | null;
  onSaved: () => void;
}) {
  const upsertFn = useServerFn(upsertServiceAssignments);
  const [csUserId, setCsUserId] = useState("");
  const [selectedServices, setSelectedServices] = useState<ServiceSelection[]>([]);

  useEffect(() => {
    setCsUserId(editing?.assigned_cs_user_id ?? "");
    setSelectedServices(
      editing
        ? [
            {
              service_name: editing.service_name,
              service_category: editing.service_category,
            },
          ]
        : [],
    );
  }, [editing, open]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!csUserId) throw new Error("Pick a CS user");
      if (selectedServices.length === 0) throw new Error("Select at least one service");
      return upsertFn({
        data: {
          assignments: selectedServices.map((service) => ({
            service_name: service.service_name,
            service_category: service.service_category,
            cs_user_id: csUserId,
          })),
        },
      });
    },
    onSuccess: () => {
      toast.success("Service assignments saved");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function addService(selection: ServiceSelection) {
    if (editing) return;
    setSelectedServices((current) => mergeServiceSelections(current, selection));
  }

  function removeSelected(serviceName: string) {
    const serviceKey = normalizeLeadService(serviceName);
    setSelectedServices((current) =>
      current.filter((item) => normalizeLeadService(item.service_name) !== serviceKey),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-visible">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Change assignment - ${editing.service_name}` : "Assign Services"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Change only the assigned CS user. This affects future incoming leads only; existing leads keep their current owner."
              : "Select a CS user and one or more services. These assignments affect only future incoming leads."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-visible">
          <div>
            <label className="text-xs font-medium text-muted-foreground">CS User</label>
            <Select value={csUserId} onValueChange={setCsUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a CS user" />
              </SelectTrigger>
              <SelectContent>
                {team.map((member) => (
                  <SelectItem key={member.user_id} value={member.user_id}>
                    {member.full_name || member.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Services</label>
            {editing ? (
              <div className="mt-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <div className="font-medium">{editing.service_name}</div>
                <div className="text-xs text-muted-foreground">
                  {editing.service_category ?? "Custom service"}
                </div>
              </div>
            ) : (
              <ServiceMultiSelector selected={selectedServices} onSelect={addService} />
            )}
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              Selected services summary
            </div>
            {selectedServices.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                No services selected.
              </div>
            ) : (
              <div className="flex max-h-36 flex-wrap gap-1.5 overflow-auto rounded-md border p-2">
                {selectedServices.map((service) => (
                  <Badge
                    key={normalizeLeadService(service.service_name) ?? service.service_name}
                    variant="secondary"
                    className="gap-1 text-xs"
                  >
                    {service.service_name}
                    {!editing ? (
                      <button
                        type="button"
                        onClick={() => removeSelected(service.service_name)}
                        aria-label={`Remove ${service.service_name}`}
                        className="ml-1 rounded-sm hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    ) : null}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServiceMultiSelector({
  selected,
  onSelect,
}: {
  selected: ServiceSelection[];
  onSelect: (selection: ServiceSelection) => void;
}) {
  const inputWrapperRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [contentWidth, setContentWidth] = useState<number | undefined>();

  const selectedKeys = useMemo(
    () => new Set(selected.map((item) => normalizeLeadService(item.service_name)).filter(Boolean)),
    [selected],
  );
  const filteredCategories = useMemo(
    () => filterServiceCategories(query, SERVICE_CATEGORIES),
    [query],
  );
  const customValue = query.trim();
  const showCustomAction =
    customValue.length > 0 &&
    !isExistingService(customValue) &&
    !selectedKeys.has(normalizeLeadService(customValue));
  const items = useMemo<ServiceListItem[]>(() => {
    const serviceItems = filteredCategories.flatMap((group) =>
      group.services.map((service) => ({
        type: "service" as const,
        category: group.category,
        service,
      })),
    );
    return showCustomAction
      ? [{ type: "custom", value: customValue }, ...serviceItems]
      : serviceItems;
  }, [customValue, filteredCategories, showCustomAction]);

  function openList() {
    setContentWidth(inputWrapperRef.current?.getBoundingClientRect().width);
    setOpen(true);
    setHighlightedIndex(0);
  }

  function selectItem(item: ServiceListItem) {
    if (item.type === "custom") {
      onSelect(toServiceSelection(item.value, null));
    } else {
      onSelect(toServiceSelection(item.service, item.category));
    }
    setQuery("");
    setOpen(true);
    setHighlightedIndex(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setHighlightedIndex((current) => Math.min(current + 1, Math.max(items.length - 1, 0)));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setHighlightedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter" && open) {
      const highlighted = items[highlightedIndex];
      if (highlighted) {
        event.preventDefault();
        selectItem(highlighted);
      }
      return;
    }

    if (event.key === "Escape") setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={inputWrapperRef} className="relative mt-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!open) setOpen(true);
              setHighlightedIndex(0);
            }}
            onClick={openList}
            onFocus={openList}
            onKeyDown={handleKeyDown}
            placeholder="Search or enter a service"
            className="pl-9"
            role="combobox"
            aria-expanded={open}
          />
        </div>
      </PopoverAnchor>
      <PopoverPrimitive.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="z-[80] overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-none"
        style={{ width: contentWidth }}
      >
        <div className="h-[280px] max-h-[calc(100vh-10rem)] overflow-y-auto overscroll-contain">
          <div role="listbox" className="p-1">
            {items.length === 0 ? (
              <div className="px-3 py-5 text-center text-sm text-muted-foreground">
                No matching services
              </div>
            ) : null}
            {items.map((item, index) => {
              if (item.type === "custom") {
                return (
                  <ServiceChoiceButton
                    key="custom"
                    selected={highlightedIndex === index}
                    checked={false}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onSelect={() => selectItem(item)}
                  >
                    Use &quot;{item.value}&quot;
                  </ServiceChoiceButton>
                );
              }

              const previous = items[index - 1];
              const showHeading =
                !previous ||
                previous.type === "custom" ||
                (previous.type === "service" && previous.category !== item.category);
              const serviceKey = normalizeLeadService(item.service);
              return (
                <div key={`${item.category}-${item.service}`}>
                  {showHeading ? (
                    <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {item.category}
                    </div>
                  ) : null}
                  <ServiceChoiceButton
                    selected={highlightedIndex === index}
                    checked={!!serviceKey && selectedKeys.has(serviceKey)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onSelect={() => selectItem(item)}
                  >
                    {item.service}
                  </ServiceChoiceButton>
                </div>
              );
            })}
          </div>
        </div>
      </PopoverPrimitive.Content>
    </Popover>
  );
}

function ServiceChoiceButton({
  selected,
  checked,
  children,
  onMouseEnter,
  onSelect,
}: {
  selected: boolean;
  checked: boolean;
  children: ReactNode;
  onMouseEnter: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseEnter={onMouseEnter}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors",
        selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {checked ? <Check className="h-4 w-4 shrink-0" /> : null}
    </button>
  );
}
