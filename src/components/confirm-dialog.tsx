import { useEffect, useState } from "react";
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
import { bindConfirmDialogProvider } from "@/components/confirm-dialog-store";
import type { Pending } from "@/components/confirm-dialog-store";
import { cn } from "@/lib/utils";

export function ConfirmDialogProvider() {
  const [pending, setP] = useState<Pending | null>(null);

  useEffect(() => bindConfirmDialogProvider(setP), []);

  const handle = (result: boolean) => {
    if (pending) pending.resolve(result);
    setP(null);
  };

  const destructive = pending?.tone === "destructive";

  return (
    <AlertDialog open={!!pending} onOpenChange={(o) => !o && handle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title ?? "Are you sure?"}</AlertDialogTitle>
          {pending?.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {pending.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => handle(false)}>
            {pending?.cancelText ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => handle(true)}
            className={cn(
              destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {pending?.confirmText ?? "Continue"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
