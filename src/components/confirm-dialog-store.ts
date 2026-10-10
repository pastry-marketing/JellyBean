import type { Dispatch, SetStateAction } from "react";

export type ConfirmOptions = {
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: "default" | "destructive";
};

export type Pending = ConfirmOptions & { resolve: (v: boolean) => void };

let setPending: ((p: Pending | null) => void) | null = null;

/**
 * Wire the mounted provider's state setter into the module-level store.
 * Called by `ConfirmDialogProvider`; returns the matching teardown.
 */
export function bindConfirmDialogProvider(
  setter: Dispatch<SetStateAction<Pending | null>>,
): () => void {
  setPending = setter;
  return () => {
    setPending = null;
  };
}

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
