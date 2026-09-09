import { describe, expect, it, vi } from "vitest";
import { composeCsLead } from "./cs-compose.server";

// Synthetic leads only: no customer records or credentials belong in this repository.
const input = {
  template: "Hi (Person first name), this is Alex.",
  customerName: "Taylor Example",
  service: "Appliance Repair",
  postText: "My Samsung refrigerator needs a filter change. I can be home Friday afternoon.",
  contextText: "Refrigerator repair",
  requirement1: "ask the brand",
};
const draft = {
  serviceContext: "a filter change for your Samsung refrigerator",
  requirement1: "share your address",
  requirement2: "",
};
const approval = { approved: true, issues: [] };

function mockAi(...replies: unknown[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const reply of replies) {
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }],
        }),
        { status: 200 },
      ),
    );
  }
  return fetcher;
}

describe("reviewed CS composition", () => {
  it("sends the full post and service to both stages and returns only an approved draft", async () => {
    const fetcher = mockAi(draft, approval);
    const result = await composeCsLead(input, { apiKey: "test-key", fetcher });
    expect(result.rephrased).toBe(
      "Hi Taylor, this is Alex. I saw your request for a filter change for your Samsung refrigerator. Could you please share your address?",
    );
    expect(result.requirement1).toBe("share your address");
    expect(result.requirement2).toBe("");
    for (const [, request] of fetcher.mock.calls) {
      const body = JSON.parse(String(request?.body));
      const source = JSON.parse(body.messages[1].content);
      expect(source.originalPost).toBe(input.postText);
      expect(source.serviceLabel).toBe(input.service);
      expect(body.response_format.json_schema.strict).toBe(true);
    }
  });

  it.each([
    {
      postText: input.postText,
      wrong: { ...draft, requirement1: "share the brand" },
      corrected: draft,
      issue: "Samsung is already supplied; ask for the missing address.",
    },
    {
      postText: "Replace the lower blower fan in my GE double oven.",
      wrong: { ...draft, serviceContext: "an oven door glass replacement" },
      corrected: {
        ...draft,
        serviceContext: "a lower blower fan replacement for your GE double oven",
      },
      issue: "Preserve the lower blower fan, not door glass.",
    },
    {
      postText: "Please clean my 8x10 rug.",
      wrong: { ...draft, requirement1: "share the rug size" },
      corrected: {
        serviceContext: "cleaning your 8x10 rug",
        requirement1: "send a photo of the rug",
        requirement2: "share your address",
      },
      issue: "The rug dimensions are known; ask for a photo and address.",
    },
    {
      postText: "Replace my garage gutters.",
      wrong: { ...draft, requirement1: "confirm if this is for the whole house" },
      corrected: {
        serviceContext: "replacing your garage gutters",
        requirement1: "send a photo of the garage gutters",
        requirement2: "share your address",
      },
      issue: "Garage scope is already specified.",
    },
  ])(
    "repairs a rejected draft using the review feedback: $issue",
    async ({ postText, wrong, corrected, issue }) => {
      const fetcher = mockAi(wrong, { approved: false, issues: [issue] }, corrected, approval);
      const result = await composeCsLead({ ...input, postText }, { apiKey: "test-key", fetcher });
      expect(result.serviceContext).toBe(corrected.serviceContext);
      expect(result.requirement1).toBe(corrected.requirement1);
      expect(fetcher).toHaveBeenCalledTimes(4);
      const repair = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
      expect(JSON.parse(repair.messages[1].content).corrections).toEqual([issue]);
    },
  );

  it("does not return a generic or unreviewed message after repeated rejection", async () => {
    const rejected = { approved: false, issues: ["This question is already answered."] };
    const fetcher = mockAi(draft, rejected, draft, rejected);
    await expect(composeCsLead(input, { apiKey: "test-key", fetcher })).rejects.toThrow(
      "Draft needs review",
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not accept an approval with unresolved issues", async () => {
    const inconsistent = { approved: true, issues: ["Wrong appliance."] };
    await expect(
      composeCsLead(input, {
        apiKey: "test-key",
        fetcher: mockAi(draft, inconsistent, draft, inconsistent),
      }),
    ).rejects.toThrow("Wrong appliance");
  });

  it("does not let operator preferences override the independent source review", async () => {
    const fetcher = mockAi(draft, approval);
    const preference = "Always ask for the brand even if it is known";
    await composeCsLead({ ...input, systemPrompt: preference }, { apiKey: "test-key", fetcher });
    const generation = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const review = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(generation.messages[0].content).toContain(preference);
    expect(review.messages[0].content).not.toContain(preference);
    expect(review.messages[0].content).toContain("information already provided");
  });

  it("rejects placeholders before a draft can pass review", async () => {
    const broken = { ...draft, requirement1: "(Requirements)" };
    const fetcher = mockAi(broken, broken);
    await expect(composeCsLead(input, { apiKey: "test-key", fetcher })).rejects.toThrow(
      "placeholders",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { finish_reason: "length", message: { content: JSON.stringify(draft) } },
    { finish_reason: "stop", message: { refusal: "Unable to comply" } },
    { finish_reason: "stop", message: { content: "not JSON" } },
  ])("never returns a refused, truncated, or malformed response", async (choice) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [choice] })));
    await expect(composeCsLead(input, { apiKey: "test-key", fetcher })).rejects.toThrow();
  });

  it("requires source text before contacting the model", async () => {
    const fetcher = mockAi();
    await expect(
      composeCsLead({ ...input, postText: "", contextText: "" }, { apiKey: "test-key", fetcher }),
    ).rejects.toThrow("customer's post");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
