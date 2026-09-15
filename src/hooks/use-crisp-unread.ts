import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export function useCrispUnread(enabled: boolean = true) {
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const isMountedRef = useRef(true);

  const fetchUnreadCount = useCallback(async () => {
    if (!enabled) return;
    try {
      const { data, error } = await supabase.rpc("get_crisp_workspace_summaries");
      if (!error && data && isMountedRef.current) {
        let total = 0;
        data.forEach((item) => {
          const unreplied = Number(item.unreplied_chat_count ?? item.total_chat_count ?? 0);
          total += unreplied;
        });
        setUnreadCount(total);
      }
    } catch {
      // Non-fatal if fetch fails
    }
  }, [enabled]);

  useEffect(() => {
    isMountedRef.current = true;
    if (!enabled) {
      setUnreadCount(0);
      return () => {
        isMountedRef.current = false;
      };
    }
    void fetchUnreadCount();

    const channel = supabase
      .channel("crisp-unread-nav-sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisp_conversations" },
        () => {
          void fetchUnreadCount();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisp_workspaces" },
        () => {
          void fetchUnreadCount();
        }
      )
      .subscribe();

    // Background heartbeat poll every 30s to keep unread badges synced even if websocket drops
    const pollInterval = setInterval(() => {
      void fetchUnreadCount();
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchUnreadCount();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      clearInterval(pollInterval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void supabase.removeChannel(channel);
    };
  }, [enabled, fetchUnreadCount]);

  return {
    unreadCount,
    hasUnread: unreadCount > 0,
  };
}
