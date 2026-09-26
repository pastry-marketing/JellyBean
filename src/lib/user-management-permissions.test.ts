import { describe, expect, it } from "vitest";
import {
  canManageRole,
  canManageTargetRoles,
  manageableRolesFor,
  resolveUserManagerRole,
} from "./user-management-permissions";

describe("user management permissions", () => {
  it("gives admin precedence and full role access", () => {
    expect(resolveUserManagerRole(["cs_admin", "admin"])).toBe("admin");
    expect(canManageRole("admin", "cs_admin")).toBe(true);
  });

  it("limits CS admins to CS users", () => {
    expect(manageableRolesFor("cs_admin")).toEqual(["cs"]);
    expect(canManageTargetRoles("cs_admin", ["cs"])).toBe(true);
    expect(canManageTargetRoles("cs_admin", ["cs_admin"])).toBe(false);
  });

  it("limits sub-admins to the four operational roles", () => {
    expect(manageableRolesFor("sub_admin")).toEqual(["maturing", "facebook", "seo", "acc_handler"]);
    expect(canManageTargetRoles("sub_admin", ["facebook"])).toBe(true);
    expect(canManageTargetRoles("sub_admin", ["cs"])).toBe(false);
    expect(canManageTargetRoles("sub_admin", ["maturing", "facebook"])).toBe(false);
  });
});
