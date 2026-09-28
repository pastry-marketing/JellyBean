import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, ExternalLink, Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatPhone } from "@/lib/crm-lite";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

type ReminderRow = {
  id: string;
  lead_id: string;
  sender_user_id: string;
  recipient_user_id: string;
  message: string;
  is_read: boolean;
  created_at: string;
};

type EnrichedReminder = ReminderRow & {
  customer_name: string | null;
  customer_number: string | null;
  sender_name: string | null;
};

export function LeadReminderNotifier() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<EnrichedReminder[]>([]);
  const [marking, setMarking] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());

  const enrich = useCallback(async (rows: ReminderRow[]): Promise<EnrichedReminder[]> => {
    if (rows.length === 0) return [];
    const leadIds = Array.from(new Set(rows.map((r) => r.lead_id)));
    const senderIds = Array.from(new Set(rows.map((r) => r.sender_user_id)));
    const [{ data: leads }, { data: profs }] = await Promise.all([
      supabase
        .from("qualified_leads")
        .select("id, customer_name, customer_number")
        .in("id", leadIds),
      supabase.from("profiles").select("user_id, full_name, email").in("user_id", senderIds),
    ]);
    const leadMap = new Map((leads ?? []).map((l) => [l.id, l]));
    const profMap = new Map((profs ?? []).map((p) => [p.user_id, p]));
    return rows.map((r) => {
      const lead = leadMap.get(r.lead_id);
      const prof = profMap.get(r.sender_user_id);
      return {
        ...r,
        customer_name: lead?.customer_name ?? null,
        customer_number: lead?.customer_number ?? null,
        sender_name: prof?.full_name || prof?.email || null,
      };
    });
  }, []);

  const enqueueRows = useCallback(
    async (rows: ReminderRow[]) => {
      const fresh = rows.filter((r) => !seenRef.current.has(r.id));
      if (fresh.length === 0) return;
      for (const r of fresh) seenRef.current.add(r.id);
      const enriched = await enrich(fresh);
      setQueue((q) => [...q, ...enriched]);
    },
    [enrich],
  );

  const loadUnread = useCallback(async () => {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from("lead_reminders" as never)
      .select("id, lead_id, sender_user_id, recipient_user_id, message, is_read, created_at")
      .eq("recipient_user_id", user.id)
      .eq("is_read", false)
      .order("created_at", { ascending: true });
    if (error || !data) return;
    await enqueueRows(data as unknown as ReminderRow[]);
  }, [user?.id, enqueueRows]);

  useEffect(() => {
    if (!user?.id) return;
    void loadUnread();

    const channel = supabase
      .channel(`lead-reminders-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "lead_reminders",
          filter: `recipient_user_id=eq.${user.id}`,
        },
        (payload) => {
          void enqueueRows([payload.new as ReminderRow]);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id, loadUnread, enqueueRows]);

  const current = queue[0];

  async function markRead(nav: boolean) {
    if (!current || !user?.id || marking) return;
    setMarking(true);
    try {
      const { error } = await supabase
        .from("lead_reminders" as never)
        .update({ is_read: true, read_at: new Date().toISOString() } as never)
        .eq("id", current.id)
        .eq("recipient_user_id", user.id);
      if (error) throw error;
      setQueue((q) => q.slice(1));
      if (nav) {
        void navigate({ to: "/app/cs-leads", search: { leadId: current.lead_id } });
      }
    } catch (err) {
      toast.error((err as Error).message || "Could not update reminder");
    } finally {
      setMarking(false);
    }
  }

  if (!current) return null;

  return (
    <Dialog
      open={true}
      onOpenChange={() => {
        /* modal — must acknowledge */
      }}
    >
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Bell className="h-4 w-4" />
            </div>
            Lead Reminder
          </DialogTitle>
          <DialogDescription>A teammate sent you a reminder about a lead.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-surface/60 px-3 py-2.5 text-[12.5px] space-y-1">
            <Row label="Customer" value={current.customer_name ?? "—"} />
            <Row
              label="Phone"
              value={
                current.customer_number
                  ? formatPhone(current.customer_number) || current.customer_number
                  : "—"
              }
            />
            <Row label="Sent by" value={current.sender_name ?? "Teammate"} />
            <Row
              label="When"
              value={formatDistanceToNow(new Date(current.created_at), { addSuffix: true })}
            />
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1 font-semibold">
              Reminder
            </div>
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
              {current.message}
            </div>
          </div>

          {queue.length > 1 && (
            <div className="text-[11px] text-muted-foreground text-center">
              +{queue.length - 1} more reminder{queue.length - 1 === 1 ? "" : "s"} after this
            </div>
          )}
        </div>

        <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
          <Button variant="outline" onClick={() => void markRead(false)} disabled={marking}>
            {marking ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
            Mark as Read
          </Button>
          <Button onClick={() => void markRead(true)} disabled={marking}>
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            View Lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground text-right truncate max-w-[65%]">{value}</span>
    </div>
  );
}
