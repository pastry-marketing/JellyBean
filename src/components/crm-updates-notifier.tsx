import { useEffect, useState, useCallback, useRef } from "react";
import { RefreshCw, Sparkles, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Notification = {
  id: string;
  title: string;
  description: string;
  affected_section: string | null;
  target_roles: string[];
  priority: string;
  is_active: boolean;
  published_at: string;
};

export function CrmUpdatesNotifier() {
  const { user, primaryRole } = useAuth();
  const [queue, setQueue] = useState<Notification[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  const enqueue = useCallback((n: Notification) => {
    if (seenRef.current.has(n.id)) return;
    seenRef.current.add(n.id);
    setQueue((q) => [...q, n]);
  }, []);

  const loadPending = useCallback(async () => {
    if (!user?.id || !primaryRole) return;
    const role = String(primaryRole).toLowerCase();
    const { data: notifs } = await supabase
      .from("crm_update_notifications")
      .select(
        "id, title, description, affected_section, target_roles, priority, is_active, published_at",
      )
      .eq("is_active", true)
      .order("published_at", { ascending: true });
    if (!notifs || notifs.length === 0) return;

    // Client-side role filter: Admin can read all rows (for history),
    // but popups must only fire when the user's role is in target_roles.
    const targeted = notifs.filter(
      (n) =>
        Array.isArray(n.target_roles) &&
        n.target_roles.map((r: string) => String(r).toLowerCase()).includes(role),
    );
    if (targeted.length === 0) return;

    const ids = targeted.map((n) => n.id);
    const { data: receipts } = await supabase
      .from("crm_update_notification_receipts")
      .select("notification_id")
      .eq("user_id", user.id)
      .in("notification_id", ids);
    const ack = new Set((receipts ?? []).map((r) => r.notification_id));
    for (const n of targeted) {
      if (!ack.has(n.id)) enqueue(n as Notification);
    }
  }, [user?.id, primaryRole, enqueue]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const loadPendingRef = useRef(loadPending);
  useEffect(() => {
    loadPendingRef.current = loadPending;
  }, [loadPending]);

  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`crm-updates-sub`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_update_notifications" },
        (payload) => {
          const n = payload.new as Notification;
          if (!n.is_active) return;
          void loadPendingRef.current();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const current = queue[0];

  async function acknowledge() {
    if (!current || !user?.id) return;
    await supabase.from("crm_update_notification_receipts").insert({
      notification_id: current.id,
      user_id: user.id,
    });
    setQueue((q) => q.slice(1));
  }

  async function acknowledgeAndRefresh() {
    await acknowledge();
    window.location.reload();
  }

  if (!current) return null;

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
  const isImportant = current.priority === "important";

  return (
    <Dialog
      open={true}
      onOpenChange={() => {
        /* modal — must acknowledge */
      }}
    >
      <DialogContent
        className="max-w-md rounded-2xl p-0 overflow-hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div
          className={
            isImportant
              ? "bg-gradient-to-br from-amber-500/15 to-transparent px-6 pt-6 pb-4"
              : "bg-gradient-to-br from-primary/12 to-transparent px-6 pt-6 pb-4"
          }
        >
          <DialogHeader className="text-left space-y-2">
            <div className="flex items-center gap-2">
              <div
                className={`grid h-9 w-9 place-items-center rounded-xl ${isImportant ? "bg-amber-500 text-white" : "bg-primary text-primary-foreground"}`}
              >
                {isImportant ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] uppercase tracking-[0.14em] font-bold text-muted-foreground">
                  CRM Update
                </span>
                {isImportant && (
                  <Badge variant="destructive" className="w-fit mt-0.5 text-[10px]">
                    Important
                  </Badge>
                )}
              </div>
            </div>
            <DialogTitle className="text-[19px] font-bold tracking-tight pt-1">
              {current.title}
            </DialogTitle>
            <DialogDescription className="text-[13.5px] leading-relaxed text-foreground/80">
              {current.description}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-6 pb-4 space-y-3 text-[12.5px]">
          {current.affected_section && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <span className="text-muted-foreground">Affected section</span>
              <span className="font-semibold text-foreground">{current.affected_section}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Published</span>
            <span className="font-medium text-foreground">
              {new Date(current.published_at).toLocaleString()}
            </span>
          </div>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
            For a true hard refresh, press{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-background border font-mono text-[11px]">
              {isMac ? "Cmd + Shift + R" : "Ctrl + Shift + R"}
            </kbd>
          </div>
        </div>

        <DialogFooter className="border-t bg-muted/30 px-6 py-3 flex-row justify-between sm:justify-between gap-2">
          <Button variant="outline" onClick={() => void acknowledge()}>
            Got It
          </Button>
          <Button onClick={() => void acknowledgeAndRefresh()}>
            <RefreshCw className="h-4 w-4" />
            Refresh CRM
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
