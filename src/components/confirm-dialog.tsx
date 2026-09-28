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
import { cn } from "@/lib/utils";

type ConfirmOptions = {
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: "default" | "destructive";
};

type Pending = ConfirmOptions & { resolve: (v: boolean) => void };

let setPending: ((p: Pending | null) => void) | null = null;

export function confirmDialog(opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setPending) {
      // Fallback if provider not mounted
      resolve(window.confirm(opts.description ?? opts.title ?? "Are you sure?"));
      return;
    }
    setPending({ ...opts, resolve });
  });
}

export async function confirmDiscardUnsaved(isDirty: boolean): Promise<boolean> {
  if (!isDirty) return true;
  return confirmDialog({
    title: "Discard unsaved changes?",
    description: "You have unsaved changes that will be lost if you close now.",
    confirmText: "Discard",
    cancelText: "Keep editing",
    tone: "destructive",
  });
}

export function ConfirmDialogProvider() {
  const [pending, setP] = useState<Pending | null>(null);

  useEffect(() => {
    setPending = setP;
    return () => {
      setPending = null;
    };
  }, []);

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
