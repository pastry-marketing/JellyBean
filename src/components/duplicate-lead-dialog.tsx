import { format } from "date-fns";
import { ExternalLink } from "lucide-react";
import { formatPhone } from "@/lib/crm-lite";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type DuplicateMatchPreview = {
  source: string;
  match: {
    id: string;
    customer_name: string;
    customer_number: string;
    customer_number_2: string | null;
    main_area: string | null;
    sub_area: string | null;
    service: string | null;
    context: string | null;
    original_lead_link: string | null;
    assigned_at: string;
  };
};

export function DuplicateLeadDialog({
  open,
  onOpenChange,
  matches,
  onConfirm,
  onCancel,
  isConfirming = false,
  confirmLabel = "Continue anyway",
  cancelLabel = "Cancel / Go back",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matches: DuplicateMatchPreview[];
  onConfirm: () => void;
  onCancel: () => void;
  isConfirming?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            This number already exists. Do you still want to continue?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The phone number you entered matches recent qualified leads. Review the previous lead
            details below before you continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 max-h-[50vh] overflow-y-auto text-[12.5px]">
          {matches.map(({ source, match }) => (
            <div
              key={`${source}-${match.id}`}
              className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-destructive">{source} duplicate</div>
                <div className="text-muted-foreground">
                  {format(new Date(match.assigned_at), "MMM d, yyyy h:mm a")}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <DetailField label="Customer" value={match.customer_name} />
                <DetailField label="Primary Number" value={formatPhone(match.customer_number)} />
                <DetailField label="Second Number" value={formatPhone(match.customer_number_2)} />
                <DetailField label="Area" value={match.main_area || match.sub_area || "—"} />
                <DetailField label="Service" value={match.service || "—"} />
                <DetailField label="Lead ID" value={match.id} />
              </div>
              <div>
                <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Context
                </Label>
                <div className="rounded-md border bg-background/70 px-3 py-2 whitespace-pre-wrap">
                  {match.context || "—"}
                </div>
              </div>
              {match.original_lead_link && (
                <a
                  href={match.original_lead_link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open previous lead link
                </a>
              )}
            </div>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isConfirming}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isConfirming}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DetailField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <Label className="block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </Label>
      <div className="text-foreground truncate" title={value}>
        {value || <span className="text-muted-foreground">-</span>}
      </div>
    </div>
  );
}
