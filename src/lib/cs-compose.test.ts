import { describe, expect, it } from "vitest";
import {
  assembleCsMessage,
  hasComposePlaceholder,
  hasComposeSource,
  validateComposeParts,
} from "./cs-compose";

const parts = {
  serviceContext: "repairs to your garage gutters",
  requirement1: "send a photo of the damaged garage gutters",
  requirement2: "share your address",
};

describe("CS message assembly", () => {
  it("does not force a question when all useful details are supplied", () => {
    const complete = { ...parts, requirement1: "", requirement2: "" };
    expect(validateComposeParts(complete)).toEqual([]);
    const message = assembleCsMessage(
      { customerName: "Taylor", template: "This is Alex." },
      complete,
    );
    expect(message).toContain("Thank you for sharing the details.");
    expect(message).not.toContain("?");
    expect(message).not.toContain("Could you please");
  });
  it("preserves the subject of photos and useful scheduling details", () => {
    const message = assembleCsMessage(
      { template: "Hi (Person first name), this is Alex.", customerName: "Élodie Martin" },
      {
        ...parts,
        requirement2: "let me know whether you are available after 4 pm",
      },
    );
    expect(message).toBe(
      "Hi Élodie, this is Alex. I saw your request for repairs to your garage gutters. Could you please send a photo of the damaged garage gutters and let me know whether you are available after 4 pm?",
    );
  });

  it("allows one useful question without a filler or an empty conjunction", () => {
    expect(
      assembleCsMessage(
        { template: "This is Maya Patel,", customerName: "" },
        { ...parts, requirement2: "" },
      ),
    ).toBe(
      "Hi there, this is Maya Patel. I saw your request for repairs to your garage gutters. Could you please send a photo of the damaged garage gutters?",
    );
  });

  it.each([
    "(Requirements)",
    "(Person first name)",
    "(Service Context)",
    "( )",
    "[name]",
    "{{service}}",
  ])("blocks unfinished placeholder %s", (placeholder) => {
    expect(hasComposePlaceholder(`Hi, please share ${placeholder}`)).toBe(true);
    expect(validateComposeParts({ ...parts, requirement1: placeholder })).toContain(
      "Remove unfinished placeholders.",
    );
  });

  it("rejects duplicate address requests but permits a pickup/drop-off pair in one request", () => {
    expect(
      validateComposeParts({
        ...parts,
        requirement1: "share the pickup address",
        requirement2: "share the drop-off address",
      }),
    ).not.toEqual([]);
    expect(
      validateComposeParts({
        ...parts,
        requirement1: "share the pickup and drop-off addresses",
        requirement2: "send a photo of the items",
      }),
    ).toEqual([]);
  });

  it("accepts an original post without an extracted context or requirements", () => {
    expect(hasComposeSource({ post_text: "Need a rug cleaned", context: "" })).toBe(true);
    expect(hasComposeSource({ context: "  ", post_text: null })).toBe(false);
  });
});
