import { describe, expect, it } from "vitest";
import { extractUsStateCodeFromArea, resolveUsStateCode } from "@/lib/us-states";

describe("US state helpers", () => {
  it("resolves state names and abbreviations", () => {
    expect(resolveUsStateCode("California")).toBe("CA");
    expect(resolveUsStateCode("ca")).toBe("CA");
    expect(resolveUsStateCode("District of Columbia")).toBe("DC");
  });

  it("detects full state names at the end of an area", () => {
    expect(extractUsStateCodeFromArea("Austin, Texas")).toBe("TX");
    expect(extractUsStateCodeFromArea("Buffalo New York")).toBe("NY");
  });

  it("detects uppercase abbreviations and explicit separators", () => {
    expect(extractUsStateCodeFromArea("Fountain Valley CA")).toBe("CA");
    expect(extractUsStateCodeFromArea("Miami, fl")).toBe("FL");
  });

  it("does not treat a lowercase word as an abbreviation", () => {
    expect(extractUsStateCodeFromArea("Fort Wayne in")).toBeNull();
  });
});
