import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

// Counts the distinct leads that still have an unread reminder. Drives the
// blinking dot next to "Pending leads" in the sidebar. Uses a SECURITY DEFINER
// RPC so cs / cs_admin / admin see the shared total regardless of who each
// reminder was addressed to. Realtime + a heartbeat poll keep it fresh even
// though a given user can only receive row events for their own reminders.
export function usePendingReminders(enabled: boolean) {
  const [count, setCount] = useState<number>(0);
  const isMountedRef = useRef(true);

  const fetchCount = useCallback(async () => {
    if (!enabled) return;
    try {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
        ) => Promise<{ data: number | null; error: { message: string } | null }>
      )("count_pending_reminder_leads");
      if (!error && isMountedRef.current) {
        setCount(Number(data ?? 0));
      }
    } catch {
      // Non-fatal if fetch fails.
    }
  }, [enabled]);

  useEffect(() => {
    isMountedRef.current = true;
    if (!enabled) {
      setCount(0);
      return () => {
        isMountedRef.current = false;
      };
    }

    void fetchCount();

    const channel = supabase
      .channel("pending-reminders-nav-sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lead_reminders" },
        () => {
          void fetchCount();
        },
      )
      .subscribe();

    const pollInterval = setInterval(() => {
      void fetchCount();
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchCount();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      clearInterval(pollInterval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void supabase.removeChannel(channel);
    };
  }, [enabled, fetchCount]);

  return { count, hasPending: count > 0 };
}
