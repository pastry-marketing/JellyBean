import type { AppRole } from "@/hooks/use-auth";
import type { Database } from "@/integrations/supabase/types";

export type CsStatus = Database["public"]["Enums"]["cs_status"];
export type LeadNote = { at: string; by: string; text: string };
export type ForwardedStatus =
  | "new"
  | "undeliver"
  | "wrong_number"
  | "wrong_lead"
  | "already_got_someone"
  | "service_provider_himself"
  | "converted"
  | "cx_interested"
  | "cx_not_interested"
  | "cx_didnt_replied"
  | "need_follow_up";

export type { AppRole };
