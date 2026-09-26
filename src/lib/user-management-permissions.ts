export const USER_MANAGEMENT_ROLES = [
  "admin",
  "sub_admin",
  "maturing",
  "cs",
  "cs_admin",
  "acc_handler",
  "facebook",
  "seo",
] as const;

export type UserManagementRole = (typeof USER_MANAGEMENT_ROLES)[number];
export type UserManagerRole = "admin" | "sub_admin" | "cs_admin";

const SUB_ADMIN_MANAGED_ROLES: readonly UserManagementRole[] = [
  "maturing",
  "facebook",
  "seo",
  "acc_handler",
];

const CS_ADMIN_MANAGED_ROLES: readonly UserManagementRole[] = ["cs"];

export function resolveUserManagerRole(roles: readonly string[]): UserManagerRole | null {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("sub_admin")) return "sub_admin";
  if (roles.includes("cs_admin")) return "cs_admin";
  return null;
}

export function manageableRolesFor(managerRole: UserManagerRole): readonly UserManagementRole[] {
  if (managerRole === "admin") return USER_MANAGEMENT_ROLES;
  if (managerRole === "sub_admin") return SUB_ADMIN_MANAGED_ROLES;
  return CS_ADMIN_MANAGED_ROLES;
}

export function canManageRole(managerRole: UserManagerRole, role: string): boolean {
  return manageableRolesFor(managerRole).includes(role as UserManagementRole);
}

export function canManageTargetRoles(
  managerRole: UserManagerRole,
  targetRoles: readonly string[],
): boolean {
  if (managerRole === "admin") return true;
  return targetRoles.length === 1 && canManageRole(managerRole, targetRoles[0]);
}
