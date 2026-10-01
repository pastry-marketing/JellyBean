import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Power, Send, Sparkles, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confirmDialog } from "@/components/confirm-dialog-store";

const ALL_ROLES: { value: AppRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "sub_admin", label: "Sub-admin" },
  { value: "cs_admin", label: "CS Admin" },
  { value: "cs", label: "CS" },
  { value: "maturing", label: "Maturing" },
  { value: "acc_handler", label: "Account Handler" },
  { value: "facebook", label: "Facebook" },
  { value: "seo", label: "SEO" },
];

const AFFECTED_SECTIONS: string[] = [
  "Dashboard",
  "Raw Leads",
  "CS Pipeline",
  "Forwarded Leads",
  "Manual Lead",
  "Browser Profiles",
  "Map",
  "Analytics",
  "Reports",
  "Lead Assignment",
  "Activity",
  "Health",
  "CRM Updates",
  "Settings",
  "General / Entire CRM",
];

type Notification = {
  id: string;
  title: string;
  description: string;
  affected_section: string | null;
  target_roles: string[];
  priority: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  published_at: string;
};

export function CrmUpdatesTab() {
  const { user, primaryRole } = useAuth();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [affectedSection, setAffectedSection] = useState("");
  const [priority, setPriority] = useState<"normal" | "important">("normal");
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);

  const { data: notifications = [], isLoading } = useQuery({
    queryKey: ["crm-updates-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_update_notifications")
        .select("*")
        .order("published_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Notification[];
    },
    enabled: primaryRole === "admin",
  });

  function toggleRole(role: string) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  async function publish() {
    if (!title.trim()) return toast.error("Title is required");
    if (!description.trim()) return toast.error("Description is required");
    if (!affectedSection) return toast.error("Please select an affected section.");
    if (selectedRoles.size === 0) return toast.error("Select at least one target role");
    setPublishing(true);
    try {
      const { error } = await supabase.from("crm_update_notifications").insert({
        title: title.trim(),
        description: description.trim(),
        affected_section: affectedSection,
        target_roles: Array.from(selectedRoles),
        priority,
        is_active: true,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
      toast.success("Update published");
      setTitle("");
      setDescription("");
      setAffectedSection("");
      setPriority("normal");
      setSelectedRoles(new Set());
      void qc.invalidateQueries({ queryKey: ["crm-updates-history"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to publish update");
    } finally {
      setPublishing(false);
    }
  }

  async function toggleActive(n: Notification) {
    const { error } = await supabase
      .from("crm_update_notifications")
      .update({ is_active: !n.is_active })
      .eq("id", n.id);
    if (error) return toast.error(error.message);
    toast.success(n.is_active ? "Disabled" : "Re-enabled");
    void qc.invalidateQueries({ queryKey: ["crm-updates-history"] });
  }

  async function remove(n: Notification) {
    const ok = await confirmDialog({
      title: "Delete this update?",
      description: `"${n.title}" and all acknowledgements will be permanently deleted.`,
      confirmText: "Delete",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("crm_update_notifications").delete().eq("id", n.id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    void qc.invalidateQueries({ queryKey: ["crm-updates-history"] });
  }

  if (primaryRole !== "admin") {
    return null;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-[24px] font-bold tracking-tight">CRM Updates</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Broadcast one-time live update notifications to selected CRM roles.
        </p>
      </div>

      <div className="rounded-2xl border bg-card p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <h2 className="text-[16px] font-semibold">New update</h2>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="title" className="text-[13px] font-medium">
              Update Title
            </Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. CS Pipeline Updated"
              className="mt-1.5"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="desc" className="text-[13px] font-medium">
              Update Description
            </Label>
            <Textarea
              id="desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What changed and what action, if any, should users take?"
              rows={4}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="section" className="text-[13px] font-medium">
              Affected Section
            </Label>
            <Select value={affectedSection} onValueChange={setAffectedSection}>
              <SelectTrigger id="section" className="mt-1.5">
                <SelectValue placeholder="Select affected section" />
              </SelectTrigger>
              <SelectContent>
                {AFFECTED_SECTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[13px] font-medium">Priority</Label>
            <Select
              value={priority}
              onValueChange={(v) => setPriority(v as "normal" | "important")}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="important">Important</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label className="text-[13px] font-medium">Target Roles</Label>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ALL_ROLES.map((r) => {
                const selected = selectedRoles.has(r.value);
                return (
                  <button
                    key={r.value}
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    onClick={() => toggleRole(r.value)}
                    className={
                      "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
                      (selected
                        ? "border-primary bg-primary/10 text-foreground shadow-sm"
                        : "border-border hover:bg-muted/50 hover:border-border-strong")
                    }
                  >
                    <span
                      className={
                        "grid h-4 w-4 shrink-0 place-content-center rounded-full border-2 transition-all " +
                        (selected ? "border-primary" : "border-border-strong")
                      }
                    >
                      <span
                        className={
                          "h-2 w-2 rounded-full transition-all " +
                          (selected ? "bg-primary scale-100" : "bg-transparent scale-0")
                        }
                      />
                    </span>
                    <span className={selected ? "font-medium" : ""}>{r.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={() => void publish()} disabled={publishing}>
            {publishing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Publish
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border bg-card shadow-sm">
        <div className="px-6 py-4 border-b">
          <h2 className="text-[15px] font-semibold">History</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            All published updates. Disable to stop delivering to users who haven't yet acknowledged.
          </p>
        </div>
        <div className="divide-y">
          {isLoading && (
            <div className="p-6 flex items-center justify-center text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
            </div>
          )}
          {!isLoading && notifications.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No updates published yet.
            </div>
          )}
          {notifications.map((n) => (
            <div
              key={n.id}
              className="p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-[14px]">{n.title}</h3>
                  {n.priority === "important" && (
                    <Badge variant="destructive" className="text-[10px]">
                      <AlertTriangle className="h-3 w-3 mr-1" /> Important
                    </Badge>
                  )}
                  {!n.is_active && (
                    <Badge variant="secondary" className="text-[10px]">
                      Disabled
                    </Badge>
                  )}
                </div>
                <p className="text-[13px] text-muted-foreground mt-1 line-clamp-2">
                  {n.description}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {n.affected_section && (
                    <Badge variant="outline" className="text-[10.5px]">
                      {n.affected_section}
                    </Badge>
                  )}
                  {n.target_roles.map((r) => (
                    <Badge key={r} variant="outline" className="text-[10.5px] capitalize">
                      {r.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
                <div className="text-[11px] text-muted-foreground mt-2">
                  Published {new Date(n.published_at).toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => void toggleActive(n)}>
                  <Power className="h-3.5 w-3.5" />
                  {n.is_active ? "Disable" : "Enable"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void remove(n)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
