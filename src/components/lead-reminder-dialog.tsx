import { useState } from "react";
import { Bell, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/error-messages";
import { formatPhone } from "@/lib/crm-lite";

export type ReminderLeadInfo = {
  id: string;
  customer_name: string;
  customer_number: string;
  assignee_name: string | null;
  is_unassigned?: boolean;
};


const MAX_LEN = 1000;

export function LeadReminderDialog({
  lead,
  open,
  onOpenChange,
}: {
  lead: ReminderLeadInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  function handleOpenChange(next: boolean) {
    if (!next && sending) return;
    if (!next) setNote("");
    onOpenChange(next);
  }

  async function handleSend() {
    if (!lead) return;
    const trimmed = note.trim();
    if (!trimmed) {
      toast.error("Please write a reminder note.");
      return;
    }
    setSending(true);
    try {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: { mode?: string; recipient_count?: number } | null; error: { message: string } | null }>
      )("send_lead_reminder", { _lead_id: lead.id, _message: trimmed });
      if (error) throw new Error(error.message);
      const count = data?.recipient_count ?? 0;
      toast.success(`Reminder sent to ${count} recipient${count === 1 ? "" : "s"}.`);
      setNote("");
      onOpenChange(false);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setSending(false);
    }
  }


  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onInteractOutside={(e) => {
          if (sending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            Send Reminder
          </DialogTitle>
          <DialogDescription>
            Sends an in-app reminder to the CS user assigned to this lead.
          </DialogDescription>
        </DialogHeader>

        {lead && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-surface/60 px-3 py-2.5 text-[12.5px] space-y-1">
              <Row label="Customer" value={lead.customer_name} />
              <Row label="Phone" value={formatPhone(lead.customer_number) || lead.customer_number} />
              <Row
                label="Recipient"
                value={lead.is_unassigned ? "All CS users" : "Assigned CS + CS admins"}
              />
            </div>




            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-foreground/90">
                Reminder Note<span className="text-destructive"> *</span>
              </label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, MAX_LEN))}
                placeholder="Write a reminder for the assigned CS user..."
                rows={5}
                disabled={sending}
                maxLength={MAX_LEN}
              />
              <div className="text-right text-[10.5px] text-muted-foreground tabular-nums">
                {note.length}/{MAX_LEN}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={sending}
          >
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={sending || !note.trim()}>
            {sending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5 mr-1.5" />
                Send Reminder
              </>
            )}
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
