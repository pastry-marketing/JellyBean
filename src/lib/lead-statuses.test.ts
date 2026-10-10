import { describe, expect, it } from "vitest";
import { Constants } from "@/integrations/supabase/types";

describe("persisted customer outcomes", () => {
  it.each(["cx_interested", "cx_not_interested", "cx_didnt_replied"] as const)(
    "supports %s as a distinct database outcome",
    (status) => {
      expect(Constants.public.Enums.cs_status).toContain(status);
      expect(status).not.toBe("converted");
    },
  );

  it("preserves existing delivered records under the converted identifier", () => {
    expect(Constants.public.Enums.cs_status).toContain("converted");
  });
});