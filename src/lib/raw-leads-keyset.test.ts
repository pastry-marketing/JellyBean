import { expect, test, describe } from "vitest";
import {
  buildRawLeadKeysetFilter,
  calculateTotalPages,
  calculateLastPageSize,
} from "./raw-leads-keyset";

describe("buildRawLeadKeysetFilter", () => {
  describe("next direction", () => {
    test("generates correct filter for non-null captured_at", () => {
      const cursor = { captured_at: "2024-01-01T12:00:00Z", id: "123" };
      const filter = buildRawLeadKeysetFilter(cursor, "next");
      expect(filter).toBe(
        'or(captured_at.lt."2024-01-01T12:00:00Z",and(captured_at.eq."2024-01-01T12:00:00Z",id.lt.123),captured_at.is.null)',
      );
    });

    test("generates correct filter for null captured_at", () => {
      const cursor = { captured_at: null, id: "456" };
      const filter = buildRawLeadKeysetFilter(cursor, "next");
      expect(filter).toBe("and(captured_at.is.null,id.lt.456)");
    });
  });

  describe("previous direction", () => {
    test("generates correct filter for non-null captured_at", () => {
      const cursor = { captured_at: "2024-01-01T12:00:00Z", id: "123" };
      const filter = buildRawLeadKeysetFilter(cursor, "previous");
      expect(filter).toBe(
        'or(captured_at.gt."2024-01-01T12:00:00Z",and(captured_at.eq."2024-01-01T12:00:00Z",id.gt.123))',
      );
    });

    test("generates correct filter for null captured_at", () => {
      const cursor = { captured_at: null, id: "456" };
      const filter = buildRawLeadKeysetFilter(cursor, "previous");
      expect(filter).toBe("or(and(captured_at.is.null,id.gt.456),captured_at.not.is.null)");
    });
  });
});

describe("pagination math", () => {
  test("calculateTotalPages handles exact multiples", () => {
    expect(calculateTotalPages(1000, 500)).toBe(2);
  });

  test("calculateTotalPages handles remainders", () => {
    expect(calculateTotalPages(185188, 500)).toBe(371);
  });

  test("calculateTotalPages minimum is 1", () => {
    expect(calculateTotalPages(0, 500)).toBe(1);
  });

  test("calculateLastPageSize handles exact multiples", () => {
    expect(calculateLastPageSize(1000, 500)).toBe(500);
  });

  test("calculateLastPageSize handles remainders", () => {
    expect(calculateLastPageSize(185188, 500)).toBe(188);
  });

  test("calculateLastPageSize returns 0 for empty list", () => {
    expect(calculateLastPageSize(0, 500)).toBe(0);
  });
});
