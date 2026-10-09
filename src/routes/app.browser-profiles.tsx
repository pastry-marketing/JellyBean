import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import ExcelJS from "exceljs";
import { downloadCsv } from "@/lib/crm-lite";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Download,
  Rocket,
  Trash2,
  Search,
  Globe,
  Plus,
  Info,
  Upload,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import { launchIncognitonProfile } from "@/lib/incogniton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/app/browser-profiles")({
  head: () => ({ meta: [
    { title: "Browser Profiles \u00b7 JellyBean" },
    { name: "description", content: "Manage browser profiles for JellyBean account operations." },
    { property: "og:title", content: "Browser Profiles \u00b7 JellyBean" },
    { property: "og:description", content: "Manage browser profiles for JellyBean account operations." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }), component: Page });

type LaunchHistoryEntry = { at: string; by: string | null };
type IncognitonProfileInsert = Database["public"]["Tables"]["incogniton_profiles"]["Insert"];
type FileFormat = "xlsx" | "csv";
type ProfileSheetRow = {
  "account name": string;
  "profile id": string;
  "account area": string;
  latitude: string | number;
  longitude: string | number;
};

type Profile = {
  id: string;
  profile_name: string;
  incogniton_profile_id: string;
  group_name: string | null;
  last_launched_at: string | null;
  launched_by_name: string | null;
  launched_by_email: string | null;
  created_at: string;
  latitude: number | null;
  longitude: number | null;
  account_area: string | null;
  launch_history: LaunchHistoryEntry[] | null;
  notes: string | null;
  is_active: boolean;
};

type SortDirection = "asc" | "desc";
type ProfileSortKey =
  | "profile_name"
  | "profile_id"
  | "group"
  | "account_area"
  | "geo"
  | "added_date"
  | "last_launched";
type ProfileSort = { key: ProfileSortKey; direction: SortDirection };

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function profileSortValue(profile: Profile, key: ProfileSortKey) {
  switch (key) {
    case "profile_name":
      return profile.profile_name;
    case "profile_id":
      return profile.incogniton_profile_id;
    case "group":
      return profile.group_name ?? "";
    case "account_area":
      return profile.account_area ?? "";
    case "geo":
      return profile.latitude != null && profile.longitude != null
        ? `${profile.latitude.toFixed(6)},${profile.longitude.toFixed(6)}`
        : "";
    case "added_date":
      return new Date(profile.created_at).getTime() || 0;
    case "last_launched":
      return profile.last_launched_at ? new Date(profile.last_launched_at).getTime() || 0 : 0;
  }
}

function compareProfiles(a: Profile, b: Profile, sort: ProfileSort) {
  const av = profileSortValue(a, sort.key);
  const bv = profileSortValue(b, sort.key);
  const result =
    typeof av === "number" && typeof bv === "number"
      ? av - bv
      : compareText(String(av), String(bv));
  return sort.direction === "asc" ? result : -result;
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-full items-center justify-between gap-1 text-left font-medium text-muted-foreground hover:text-foreground"
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      <Icon className="h-3 w-3 shrink-0" />
    </button>
  );
}

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Browser Profiles"
        description="Add your Incogniton profile IDs here and launch them with one click."
      />
      <PageBody className="!pt-5">
        <RoleGate
          allow={["admin", "sub_admin", "scraping", "acc_handler"]}
          current={auth.primaryRole}
        >
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const qc = useQueryClient();
  const auth = useAuth();
  const [query, setQuery] = useState("");
  const [addedDateFilter, setAddedDateFilter] = useState("");
  const [profileSort, setProfileSort] = useState<ProfileSort>({
    key: "added_date",
    direction: "desc",
  });
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<Profile | null>(null);
  const [noteFor, setNoteFor] = useState<Profile | null>(null);
  const [howToOpen, setHowToOpen] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set());

  const profiles = useQuery({
    queryKey: ["incog_profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("incogniton_profiles")
        .select(
          "id, profile_name, incogniton_profile_id, group_name, account_area, latitude, longitude, last_launched_at, launched_by_name, launched_by_email, created_at, launch_history, notes, is_active",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Profile[];
    },
    placeholderData: keepPreviousData,
  });

  const groups = useMemo(
    () =>
      Array.from(
        new Set((profiles.data ?? []).map((p) => p.group_name).filter((g): g is string => !!g)),
      ).sort(),
    [profiles.data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (profiles.data ?? []).filter((p) => {
      if (addedDateFilter && dateKey(p.created_at) !== addedDateFilter) return false;
      if (!q) return true;
      return (
        p.profile_name.toLowerCase().includes(q) ||
        p.incogniton_profile_id.toLowerCase().includes(q) ||
        (p.account_area ?? "").toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => compareProfiles(a, b, profileSort));
  }, [addedDateFilter, profileSort, profiles.data, query]);

  const toggleProfileSort = (key: ProfileSortKey) => {
    setProfileSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "added_date" || key === "last_launched" ? "desc" : "asc" },
    );
  };

  useEffect(() => {
    const validIds = new Set((profiles.data ?? []).map((profile) => profile.id));
    setSelectedProfileIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [profiles.data]);

  const selectedProfiles = useMemo(() => {
    return (profiles.data ?? []).filter((profile) => selectedProfileIds.has(profile.id));
  }, [profiles.data, selectedProfileIds]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((profile) => selectedProfileIds.has(profile.id));

  function toggleProfileSelection(profileId: string, checked: boolean) {
    setSelectedProfileIds((current) => {
      const next = new Set(current);
      if (checked) next.add(profileId);
      else next.delete(profileId);
      return next;
    });
  }

  function toggleAllFiltered(checked: boolean) {
    setSelectedProfileIds((current) => {
      const next = new Set(current);
      for (const profile of filtered) {
        if (checked) next.add(profile.id);
        else next.delete(profile.id);
      }
      return next;
    });
  }

  async function launch(p: Profile) {
    toast.loading("Launching profile…", { id: "launch" });
    try {
      await launchIncognitonProfile(p.incogniton_profile_id);
      const user = auth.user;
      const who = user?.user_metadata?.full_name ?? user?.email?.split("@")[0] ?? "Unknown";
      const nowIso = new Date().toISOString();
      const prevHistory = Array.isArray(p.launch_history) ? p.launch_history : [];
      const nextHistory = [{ at: nowIso, by: who }, ...prevHistory].slice(0, 100);
      supabase
        .from("incogniton_profiles")
        .update({
          last_launched_at: nowIso,
          launched_by_name: who,
          launched_by_email: user?.email ?? null,
          launch_history: nextHistory as Json,
        })
        .eq("id", p.id)
        .then(() => qc.invalidateQueries({ queryKey: ["incog_profiles"] }));
      toast.success("Launch command sent ✓ — Incogniton should open the profile now.", {
        id: "launch",
      });
    } catch (e) {
      toast.error(
        "Could not launch. Make sure: (1) Incogniton is open, (2) the Bridge is installed on this PC. See README.txt in the bridge folder.",
        { id: "launch", duration: 6000 },
      );
    }
  }

  async function remove(p: Profile) {
    if (!confirm(`Delete profile "${p.profile_name}"? This only removes it from this CRM.`)) return;
    const { error } = await supabase.from("incogniton_profiles").delete().eq("id", p.id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["incog_profiles"] });
  }

  const [downloadingBridge, setDownloadingBridge] = useState(false);
  const [downloadingExtension, setDownloadingExtension] = useState(false);

  const handleDownloadBridge = async () => {
    setDownloadingBridge(true);
    try {
      const { data, error } = await supabase.storage
        .from("crm-downloads")
        .createSignedUrl("incogniton-bridge.zip", 60 * 10);

      if (error || !data?.signedUrl) {
        toast.error("Failed to generate download link for Bridge.");
        return;
      }
      window.open(data.signedUrl, "_blank");
    } catch (e) {
      toast.error("An unexpected error occurred.");
    } finally {
      setDownloadingBridge(false);
    }
  };

  const handleDownloadExtension = async () => {
    setDownloadingExtension(true);
    try {
      const { data, error } = await supabase.storage
        .from("crm-downloads")
        .createSignedUrl("scraping-extension.zip", 60 * 10);

      if (error || !data?.signedUrl) {
        toast.error("Failed to generate download link for Extension.");
        return;
      }
      window.open(data.signedUrl, "_blank");
    } catch (e) {
      toast.error("An unexpected error occurred.");
    } finally {
      setDownloadingExtension(false);
    }
  };

  async function removeSelected() {
    const ids = [...selectedProfileIds];
    if (ids.length === 0) return;
    const names = selectedProfiles
      .slice(0, 5)
      .map((profile) => profile.profile_name)
      .join(", ");
    const extra = ids.length > 5 ? ` and ${ids.length - 5} more` : "";
    if (
      !confirm(
        `Delete ${ids.length} selected profile${ids.length === 1 ? "" : "s"}?\n\n${names}${extra}`,
      )
    ) {
      return;
    }
    const { error } = await supabase.from("incogniton_profiles").delete().in("id", ids);
    if (error) return toast.error(error.message);
    toast.success(`Deleted ${ids.length} profile${ids.length === 1 ? "" : "s"}`);
    setSelectedProfileIds(new Set());
    qc.invalidateQueries({ queryKey: ["incog_profiles"] });
  }

  function statusOf(p: Profile) {
    if (!p.last_launched_at) return "Not launched yet";
    return Date.now() - new Date(p.last_launched_at).getTime() < 30 * 60 * 1000
      ? "Launched recently"
      : "Not launched recently";
  }

  async function toggleActive(p: Profile) {
    const nextState = !p.is_active;
    qc.setQueryData(["incog_profiles"], (old: Profile[] | undefined) => {
      if (!old) return old;
      return old.map((profile) =>
        profile.id === p.id ? { ...profile, is_active: nextState } : profile,
      );
    });

    const { error } = await supabase
      .from("incogniton_profiles")
      .update({ is_active: nextState })
      .eq("id", p.id);
    if (error) {
      toast.error(error.message);
      qc.invalidateQueries({ queryKey: ["incog_profiles"] });
    } else {
      toast.success(nextState ? "Profile set to Active" : "Profile set to Inactive");
    }
  }

  function dateKey(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatAddedDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="space-y-4">
      {/* How launch works — info banner */}
      <div className="text-[12px] bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
        <div>
          <span className="font-medium">How launching works:</span> Click{" "}
          <strong>Add Profile</strong> below to save your Incogniton profile ID and name. Then hit{" "}
          <strong>Launch</strong> — it sends the open command directly to Incogniton on your PC.
          Make sure Incogniton is running. Not sure of your profile ID?{" "}
          <button className="underline text-primary" onClick={() => setHowToOpen(true)}>
            See how to find it.
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search profile name or ID…"
            className="h-9 pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="added-date-filter" className="text-[12px] text-muted-foreground">
            Added
          </Label>
          <Input
            id="added-date-filter"
            type="date"
            value={addedDateFilter}
            onChange={(event) => setAddedDateFilter(event.target.value)}
            className="h-9 w-[150px]"
          />
          {addedDateFilter && (
            <Button variant="ghost" size="sm" onClick={() => setAddedDateFilter("")}>
              Clear
            </Button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {selectedProfiles.length > 0 && (
            <Button variant="outline" onClick={removeSelected} className="text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete {selectedProfiles.length}
            </Button>
          )}
          <Button variant="outline" onClick={handleDownloadBridge} disabled={downloadingBridge}>
            {downloadingBridge ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5" />
            )}{" "}
            Bridge
          </Button>
          <Button
            variant="outline"
            onClick={handleDownloadExtension}
            disabled={downloadingExtension}
          >
            {downloadingExtension ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5" />
            )}{" "}
            Extension
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-3.5 w-3.5 mr-1.5" /> Import
          </Button>
          {auth.primaryRole === "admin" && (
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export
            </Button>
          )}
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Profile
          </Button>
        </div>
      </div>

      <div className="bg-card border rounded-lg overflow-x-auto">
        <table className="crm-table min-w-[1100px]">
          <thead>
            <tr>
              <th className="w-10">
                <Checkbox
                  checked={allFilteredSelected}
                  disabled={filtered.length === 0}
                  aria-label="Select all visible profiles"
                  onCheckedChange={(checked) => toggleAllFiltered(checked === true)}
                />
              </th>
              <th>
                <SortHeader
                  label="Profile Name"
                  active={profileSort.key === "profile_name"}
                  direction={profileSort.direction}
                  onClick={() => toggleProfileSort("profile_name")}
                />
              </th>
              <th>
                <SortHeader
                  label="Profile ID"
                  active={profileSort.key === "profile_id"}
                  direction={profileSort.direction}
                  onClick={() => toggleProfileSort("profile_id")}
                />
              </th>
              <th>
                <SortHeader
                  label="Group"
                  active={profileSort.key === "group"}
                  direction={profileSort.direction}
                  onClick={() => toggleProfileSort("group")}
                />
              </th>
              <th>
                <SortHeader
                  label="Account Area"
                  active={profileSort.key === "account_area"}
                  direction={profileSort.direction}
                  onClick={() => toggleProfileSort("account_area")}
                />
              </th>
              <th>
                <SortHeader
                  label="Geo"
                  active={profileSort.key === "geo"}
                  direction={profileSort.direction}
                  onClick={() => toggleProfileSort("geo")}
                />
              </th>
              <th>
                <SortHeader
                  label="Added Date"
                  active={profileSort.key === "added_date"}
                  direction={profileSort.direction}
                  onClick={() => toggleProfileSort("added_date")}
                />
              </th>
              <th>
                <SortHeader
                  label="Last Launched"
                  active={profileSort.key === "last_launched"}
                  direction={profileSort.direction}
                  onClick={() => toggleProfileSort("last_launched")}
                />
              </th>
              <th>Status</th>
              <th>Notes</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {profiles.isLoading && !profiles.data && (
              <tr>
                <td colSpan={11} className="text-center py-6 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!profiles.isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="text-center py-10 text-muted-foreground">
                  <Globe className="h-5 w-5 inline mr-2 opacity-50" />
                  No browser profiles added yet.
                </td>
              </tr>
            )}
            {filtered.map((p) => {
              const status = statusOf(p);
              return (
                <tr key={p.id} className="crm-data-row">
                  <td>
                    <Checkbox
                      checked={selectedProfileIds.has(p.id)}
                      aria-label={`Select ${p.profile_name}`}
                      onCheckedChange={(checked) => toggleProfileSelection(p.id, checked === true)}
                    />
                  </td>
                  <td className="font-medium">{p.profile_name}</td>
                  <td className="font-mono text-[11px] text-muted-foreground">
                    {p.incogniton_profile_id}
                  </td>
                  <td className="text-[12.5px]">{p.group_name ?? "—"}</td>
                  <td className="text-[12.5px]">{p.account_area ?? "—"}</td>
                  <td className="text-[11.5px] font-mono text-muted-foreground">
                    {p.latitude != null && p.longitude != null
                      ? `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`
                      : "—"}
                  </td>
                  <td className="text-[12px] whitespace-nowrap">
                    <div className="font-medium">{formatAddedDate(p.created_at)}</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {new Date(p.created_at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </td>
                  <td>
                    {p.last_launched_at ? (
                      <button
                        type="button"
                        onClick={() => setHistoryFor(p)}
                        className="flex flex-col gap-0.5 text-left hover:opacity-80"
                        title="View last 5 launches"
                      >
                        <span
                          className={cn(
                            "text-[10.5px] px-2 py-0.5 rounded-full border w-fit",
                            status === "Launched recently"
                              ? "bg-success/10 text-success border-success/30"
                              : "bg-muted text-muted-foreground border-border",
                          )}
                        >
                          {status}
                        </span>
                        <span className="text-[11px] font-medium text-foreground pl-0.5">
                          {p.launched_by_name ?? p.launched_by_email ?? "Unknown"}
                        </span>
                        <span className="text-[10px] text-muted-foreground pl-0.5">
                          {new Date(p.last_launched_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/50 italic">
                        Never launched
                      </span>
                    )}
                  </td>
                  <td>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleActive(p)}
                      className={cn(
                        "text-[11px] h-7 px-2",
                        p.is_active
                          ? "text-success border-success/30"
                          : "text-muted-foreground border-border",
                      )}
                    >
                      {p.is_active ? "Active" : "Inactive"}
                    </Button>
                  </td>
                  <td className="max-w-[120px]">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setNoteFor(p)}
                      className="h-7 px-2 text-[11px]"
                    >
                      {p.notes ? "Edit Note" : "Add Note"}
                    </Button>
                    {p.notes && (
                      <div
                        className="text-[10px] text-muted-foreground truncate mt-0.5"
                        title={p.notes}
                      >
                        {p.notes}
                      </div>
                    )}
                  </td>
                  <td className="text-right space-x-1.5 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => launch(p)}
                      title="Launch in Incogniton"
                    >
                      <Rocket className="h-3.5 w-3.5 mr-1" /> Launch
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => remove(p)} title="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <AddProfileDialog
          userId={auth.user?.id ?? null}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            qc.invalidateQueries({ queryKey: ["incog_profiles"] });
          }}
        />
      )}
      <ImportDialog
        open={importOpen}
        userId={auth.user?.id ?? null}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          qc.invalidateQueries({ queryKey: ["incog_profiles"] });
        }}
      />
      <ExportDialog
        open={exportOpen}
        profiles={profiles.data ?? []}
        groups={groups}
        onClose={() => setExportOpen(false)}
      />
      {noteFor && (
        <Dialog open onOpenChange={(o) => !o && setNoteFor(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Note · {noteFor.profile_name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <textarea
                className="w-full min-h-[100px] text-sm p-3 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                defaultValue={noteFor.notes || ""}
                id="note-input"
                placeholder="Type your note here..."
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setNoteFor(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    const val = (
                      document.getElementById("note-input") as HTMLTextAreaElement
                    ).value.trim();
                    qc.setQueryData(["incog_profiles"], (old: Profile[] | undefined) => {
                      if (!old) return old;
                      return old.map((profile) =>
                        profile.id === noteFor.id ? { ...profile, notes: val } : profile,
                      );
                    });
                    setNoteFor(null);
                    const { error } = await supabase
                      .from("incogniton_profiles")
                      .update({ notes: val })
                      .eq("id", noteFor.id);
                    if (error) {
                      toast.error(error.message);
                      qc.invalidateQueries({ queryKey: ["incog_profiles"] });
                    } else {
                      toast.success("Note saved");
                    }
                  }}
                >
                  Save Note
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {historyFor && (
        <Dialog open onOpenChange={(o) => !o && setHistoryFor(null)}>
          <DialogContent className="max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Last 5 launches · {historyFor.profile_name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              {(historyFor.launch_history ?? []).length === 0 ? (
                <div className="text-[12.5px] text-muted-foreground">No history yet.</div>
              ) : (
                (historyFor.launch_history ?? []).slice(0, 5).map((h, i) => (
                  <div
                    key={i}
                    className="flex justify-between text-[12.5px] bg-muted/30 rounded px-3 py-2"
                  >
                    <span className="font-medium">{h.by ?? "Unknown"}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {new Date(h.at).toLocaleString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* How to find profile ID */}
      <Dialog open={howToOpen} onOpenChange={setHowToOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>How to find your Incogniton Profile ID</DialogTitle>
            <DialogDescription>
              The Profile ID is the unique identifier Incogniton uses to open a profile.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-[13px]">
            <div className="space-y-2">
              <div className="font-medium">Method 1 — From the Incogniton app (easiest)</div>
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                <li>Open the Incogniton desktop app.</li>
                <li>
                  Right-click any profile → <strong>Profile Info</strong> or <strong>Edit</strong>.
                </li>
                <li>Copy the ID shown at the top (looks like a long number or UUID).</li>
              </ol>
            </div>
            <div className="space-y-2">
              <div className="font-medium">Method 2 — From the local API</div>
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                <li>Make sure Incogniton is running.</li>
                <li>
                  Open this URL in your browser tab:{" "}
                  <code className="font-mono text-[11px] bg-muted px-1 py-0.5 rounded">
                    http://localhost:35000/profile/all
                  </code>
                </li>
                <li>
                  You'll see a JSON list. Find your profile and copy the{" "}
                  <code className="font-mono text-[11px]">profile_browser_id</code> field.
                </li>
              </ol>
            </div>
            <div className="bg-muted/40 rounded p-3 text-[12px] text-muted-foreground">
              <strong>Tip:</strong> The profile name is just a label for your CRM — it doesn't need
              to match the name in Incogniton exactly, but keeping them the same avoids confusion.
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const PROFILE_SHEET_HEADERS = [
  "account name",
  "profile id",
  "account area",
  "latitude",
  "longitude",
] as const;

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function toSheetRow(profile: Profile): ProfileSheetRow {
  return {
    "account name": profile.profile_name,
    "profile id": profile.incogniton_profile_id,
    "account area": profile.account_area ?? "",
    latitude: profile.latitude ?? "",
    longitude: profile.longitude ?? "",
  };
}

function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      field = "";
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  if (rows.length === 0) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows
    .slice(1)
    .map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
    );
}

function normalizeSheetRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value])),
  );
}

function validateSheetRows(rawRows: Record<string, unknown>[]) {
  if (rawRows.length === 0) throw new Error("The selected file has no profile rows.");
  const missingHeaders = PROFILE_SHEET_HEADERS.filter((header) => !(header in rawRows[0]));
  if (missingHeaders.length > 0) {
    throw new Error(`Missing required column header: ${missingHeaders.join(", ")}`);
  }

  return rawRows.map((row, index) => {
    const rowNumber = index + 2;
    const accountName = String(row["account name"] ?? "").trim();
    const profileId = String(row["profile id"] ?? "").trim();
    const accountArea = String(row["account area"] ?? "").trim();
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);

    if (!accountName) throw new Error(`Row ${rowNumber}: account name is required.`);
    if (!profileId) throw new Error(`Row ${rowNumber}: profile id is required.`);
    if (!accountArea) throw new Error(`Row ${rowNumber}: account area is required.`);
    if (!Number.isFinite(latitude)) throw new Error(`Row ${rowNumber}: latitude must be a number.`);
    if (!Number.isFinite(longitude))
      throw new Error(`Row ${rowNumber}: longitude must be a number.`);
    if (latitude < -90 || latitude > 90) {
      throw new Error(`Row ${rowNumber}: latitude must be between -90 and 90.`);
    }
    if (longitude < -180 || longitude > 180) {
      throw new Error(`Row ${rowNumber}: longitude must be between -180 and 180.`);
    }

    return {
      profile_name: accountName,
      incogniton_profile_id: profileId,
      account_area: accountArea,
      latitude,
      longitude,
    };
  });
}

async function downloadProfiles(filenameBase: string, format: FileFormat, rows: ProfileSheetRow[]) {
  if (format === "csv") {
    const headers = [...PROFILE_SHEET_HEADERS];
    const dataRows = rows.map((row) => headers.map((h) => row[h] ?? ""));
    downloadCsv(`${filenameBase}.csv`, headers, dataRows);
    return;
  }

  // Export xlsx
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Browser Profiles");
  worksheet.columns = PROFILE_SHEET_HEADERS.map((h) => ({ header: h, key: h }));
  rows.forEach((row) => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Add Profile Dialog (manual entry — works 100% without CORS/extensions) ───

function AddProfileDialog({
  userId,
  onClose,
  onSaved,
}: {
  userId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [accountArea, setAccountArea] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const id = profileId.trim();
    const name = profileName.trim();
    const area = accountArea.trim();
    const latStr = latitude.trim();
    const lngStr = longitude.trim();
    if (!id) {
      toast.error("Profile ID is required");
      return;
    }
    if (!name) {
      toast.error("Profile name is required");
      return;
    }
    if (!area) {
      toast.error("Account Area is required");
      return;
    }
    if (!latStr || !lngStr) {
      toast.error("Latitude and longitude are required");
      return;
    }
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      toast.error("Latitude and longitude must be valid numbers");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("incogniton_profiles").upsert(
      {
        incogniton_profile_id: id,
        profile_name: name,
        group_name: groupName.trim() || null,
        account_area: area,
        latitude: lat,
        longitude: lng,
        created_by: userId,
      } satisfies IncognitonProfileInsert,
      { onConflict: "incogniton_profile_id", ignoreDuplicates: false },
    );
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Profile saved ✓");
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-card w-full max-w-md rounded-lg border p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold">Add Incogniton Profile</h2>
          <p className="text-[12px] text-muted-foreground mt-1">
            Only Group is optional. Geo coordinates will plot the profile on the map with a 50-mile
            radius.
          </p>
        </div>

        <div className="space-y-3">
          <Field label="Profile ID *">
            <Input
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              placeholder="e.g. 1234567890 or abc-def-123"
              autoFocus
            />
          </Field>
          <Field label="Profile Name *">
            <Input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="e.g. Account A – Facebook"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Group (optional)">
              <Input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. testing"
              />
            </Field>
            <Field label="Account Area *">
              <Input
                value={accountArea}
                onChange={(e) => setAccountArea(e.target.value)}
                placeholder="e.g. CA · Fountain Valley"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude *">
              <Input
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="e.g. 33.7092"
                inputMode="decimal"
              />
            </Field>
            <Field label="Longitude *">
              <Input
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="e.g. -117.9536"
                inputMode="decimal"
              />
            </Field>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save Profile
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Export Dialog ─────────────────────────────────────────────────────────────

function ImportDialog({
  open,
  userId,
  onClose,
  onImported,
}: {
  open: boolean;
  userId: string | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const [format, setFormat] = useState<FileFormat>("xlsx");
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const safeClose = () => {
    if (!importing) onClose();
  };

  async function readRows() {
    if (!file) throw new Error("Choose a file to import.");
    if (format === "csv") return parseCsv(await file.text());

    const buffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("The workbook does not contain any sheets.");
    const rows: Record<string, unknown>[] = [];
    const headers: string[] = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        const values = row.values as unknown[];
        for (let i = 1; i < values.length; i++) {
          headers.push(String(values[i] ?? "").trim());
        }
      } else {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < headers.length; i++) {
          const cellValue = row.getCell(i + 1).value;
          let val = cellValue;
          if (cellValue && typeof cellValue === "object") {
            if ("result" in cellValue) {
              val = cellValue.result;
            } else if ("text" in cellValue) {
              val = cellValue.text;
            }
          }
          obj[headers[i]] = val ?? "";
        }
        rows.push(obj);
      }
    });
    return normalizeSheetRows(rows);
  }

  async function importProfiles() {
    setImporting(true);
    try {
      if (!userId) throw new Error("You must be signed in to import profiles.");
      const allRows = validateSheetRows(await readRows()).map(
        (row) =>
          ({
            ...row,
            created_by: userId,
          }) satisfies IncognitonProfileInsert,
      );
      // Dedupe by incogniton_profile_id (FIRST occurrence wins) — Postgres ON CONFLICT
      // rejects batches that hit the same conflict target twice.
      const dedup = new Map<string, IncognitonProfileInsert>();
      const skippedRows: { profile_name: string; incogniton_profile_id: string }[] = [];
      for (const row of allRows) {
        if (dedup.has(row.incogniton_profile_id)) {
          skippedRows.push({
            profile_name: row.profile_name,
            incogniton_profile_id: row.incogniton_profile_id,
          });
        } else {
          dedup.set(row.incogniton_profile_id, row);
        }
      }
      const rows = Array.from(dedup.values());
      const BATCH_SIZE = 50;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { error } = await withTimeout(
          supabase.from("incogniton_profiles").upsert(batch, {
            onConflict: "incogniton_profile_id",
            ignoreDuplicates: false,
          }),
          20000,
          "Import timed out. Please try a smaller file or check your connection.",
        );
        if (error) {
          console.error("[Import profiles] Supabase error:", error);
          throw new Error(
            error.message ||
              error.hint ||
              error.details ||
              "Database rejected the import (check your role / RLS).",
          );
        }
      }

      if (skippedRows.length > 0) {
        const preview = skippedRows
          .slice(0, 8)
          .map((r) => `• ${r.profile_name}`)
          .join("\n");
        const extra = skippedRows.length > 8 ? `\n…and ${skippedRows.length - 8} more` : "";
        toast.warning(
          `Imported ${rows.length} • Skipped ${skippedRows.length} duplicate profile id${skippedRows.length === 1 ? "" : "s"}`,
          { description: preview + extra, duration: 12000 },
        );
        console.warn("[Import profiles] Skipped duplicates:", skippedRows);
      } else {
        toast.success(`Imported ${rows.length} profile${rows.length === 1 ? "" : "s"}`);
      }
      onImported();
    } catch (error) {
      console.error("[Import profiles] Failed:", error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : "Could not import profiles";
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && safeClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import Profiles</DialogTitle>
          <DialogDescription>
            Bulk-add Incogniton profiles from an XLSX or CSV file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="block mb-1.5">Format</Label>
            <Select value={format} onValueChange={(value) => setFormat(value as FileFormat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="xlsx">XLSX</SelectItem>
                <SelectItem value="csv">CSV</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="block mb-1.5">File</Label>
            <Input
              type="file"
              accept={format === "xlsx" ? ".xlsx" : ".csv,text/csv"}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="bg-muted/40 rounded p-3 text-[12px] text-muted-foreground">
            Required headers: account name, profile id, account area, latitude, longitude.
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={safeClose} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={importProfiles} disabled={importing || !file}>
            {importing && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Import
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExportDialog({
  open,
  profiles,
  groups,
  onClose,
}: {
  open: boolean;
  profiles: Profile[];
  groups: string[];
  onClose: () => void;
}) {
  const [group, setGroup] = useState(groups[0] ?? "__all__");
  const [format, setFormat] = useState<FileFormat>("xlsx");
  const [exporting, setExporting] = useState(false);

  async function download() {
    setExporting(true);
    try {
      const rows =
        group === "__all__" ? profiles : profiles.filter((p) => (p.group_name ?? "") === group);
      if (rows.length === 0) {
        toast.error("No profiles in this group");
        return;
      }
      await downloadProfiles(`incogniton-${group}`, format, rows.map(toSheetRow));
      toast.success(`Exported ${rows.length} profile${rows.length === 1 ? "" : "s"}`);
      onClose();
    } catch (error) {
      console.error("[Export profiles] Failed:", error);
      toast.error(error instanceof Error ? error.message : "Could not export profiles");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !exporting && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export Profiles</DialogTitle>
          <DialogDescription>Download profiles as an XLSX or CSV file.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="block mb-1.5">Group</Label>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All profiles</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="block mb-1.5">Format</Label>
            <Select value={format} onValueChange={(value) => setFormat(value as FileFormat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="xlsx">XLSX</SelectItem>
                <SelectItem value="csv">CSV</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={exporting}>
            Cancel
          </Button>
          <Button onClick={download} disabled={exporting}>
            {exporting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Export
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="block mb-1.5 text-[12px]">{label}</Label>
      {children}
    </div>
  );
}
