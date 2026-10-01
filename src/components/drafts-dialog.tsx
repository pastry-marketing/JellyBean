import { useEffect, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { listMyDrafts, deleteDraft, type LeadDraft, type DraftSourceType } from "@/lib/lead-drafts";
import { sendDraftToCS, DraftValidationError } from "@/lib/send-draft-to-cs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2, FolderOpen, Send } from "lucide-react";
import { toast } from "sonner";
import { confirmDialog } from "@/components/confirm-dialog-store";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/crm-lite";

interface DraftsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Only show drafts matching this source type. Both types are stored in the
  // same table, so we still filter client-side by requested source.
  filterSource?: DraftSourceType | "all";
  onOpenDraft: (draft: LeadDraft) => void;
}

export function DraftsDialog({
  open,
  onOpenChange,
  filterSource = "all",
  onOpenDraft,
}: DraftsDialogProps) {
  const { user, profile, primaryRole } = useAuth();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<LeadDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const rows = await listMyDrafts(user.id);
      setDrafts(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const visible = drafts.filter((d) =>
    filterSource === "all" ? true : d.source_type === filterSource,
  );

  async function handleDelete(id: string) {
    const ok = await confirmDialog({
      title: "Delete draft?",
      description: "This draft will be removed. The original lead is not affected.",
      confirmText: "Delete",
      cancelText: "Cancel",
      tone: "destructive",
    });
    if (!ok) return;
    setDeletingId(id);
    try {
      await deleteDraft(id);
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      qc.invalidateQueries({ queryKey: ["lead-drafts-count"] });
      toast.success("Draft deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete draft");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSendToCS(draft: LeadDraft) {
    if (!user?.id) return;
    setSendingId(draft.id);
    try {
      await sendDraftToCS(draft, {
        userId: user.id,
        actorName: profile?.full_name ?? profile?.username ?? profile?.email ?? null,
        actorRole: primaryRole ?? null,
      });
      // Remove draft only after successful submission.
      try {
        await deleteDraft(draft.id);
      } catch {
        // best-effort; the send already succeeded.
      }
      setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      qc.invalidateQueries({ queryKey: ["lead-drafts-count"] });
      qc.invalidateQueries({ queryKey: ["raw-lead-cache"] });
      qc.invalidateQueries({ queryKey: ["raw-lead-counts"] });
      qc.invalidateQueries({ queryKey: ["my-submitted-leads"] });
      toast.success("Lead sent to CS successfully.");
    } catch (err) {
      if (err instanceof DraftValidationError) {
        toast.error(
          "Required fields are missing. Open the draft and complete all required information before sending it to CS.",
          { description: `Missing: ${err.missing.join(", ")}` },
        );
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to send draft");
      }
    } finally {
      setSendingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="p-6 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5" />
            Draft Leads
          </DialogTitle>
          <DialogDescription>
            Your saved drafts from Raw Leads and Manual Leads. Only you can see these.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto px-6 pb-6">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading drafts…
            </div>
          ) : visible.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-sm">
              No drafts saved yet.
            </div>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Area</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Post Link</TableHead>
                    <TableHead>Last Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((d) => {
                    const f = d.form_data ?? {};
                    const num = (f.customerNumber as string) || "";
                    const snapshot = (f.entrySnapshot ?? {}) as {
                      lead_link?: string | null;
                      canonical_lead_link?: string | null;
                    };
                    const postLink =
                      (f.originalLeadLink as string | null | undefined) ||
                      snapshot.lead_link ||
                      snapshot.canonical_lead_link ||
                      "";
                    return (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">
                          {(f.customerName as string) || "—"}
                        </TableCell>
                        <TableCell>{num ? formatPhone(num) : "—"}</TableCell>
                        <TableCell>{(f.area as string) || "—"}</TableCell>
                        <TableCell>{(f.service as string) || "—"}</TableCell>
                        <TableCell>
                          <Badge variant={d.source_type === "raw_lead" ? "secondary" : "outline"}>
                            {d.source_type === "raw_lead" ? "Raw Lead" : "Manual Lead"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {postLink ? (
                            <a
                              href={postLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline text-xs"
                            >
                              View Post
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(d.updated_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                onOpenDraft(d);
                                onOpenChange(false);
                              }}
                            >
                              Open
                            </Button>
                            <Button
                              size="sm"
                              variant="default"
                              onClick={() => void handleSendToCS(d)}
                              disabled={sendingId === d.id}
                              aria-label="Send draft to CS"
                            >
                              {sendingId === d.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <>
                                  <Send className="w-3.5 h-3.5 mr-1" />
                                  Send to CS
                                </>
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void handleDelete(d.id)}
                              disabled={deletingId === d.id}
                              aria-label="Delete draft"
                            >
                              {deletingId === d.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5 text-destructive" />
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
