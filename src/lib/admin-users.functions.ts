import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivity } from "@/lib/activity-log";

const roleSchema = z.enum([
  "admin",
  "sub_admin",
  "maturing",
  "cs",
  "cs_admin",
  "acc_handler",
  "facebook",
  "seo",
]);

const createUserSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  username: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  password: z.string().min(8).max(128),
  role: roleSchema,
  isActive: z.boolean().default(true),
});

function deriveUsername(email: string): string {
  const base =
    email
      .split("@")[0]
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .slice(0, 50) || "user";
  return base;
}

async function ensureRequesterIsAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

async function loadActorName(userId: string) {
  try {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("full_name, username, email")
      .eq("user_id", userId)
      .maybeSingle();
    return data?.full_name || data?.username || data?.email || null;
  } catch {
    return null;
  }
}

// Bootstrap: allow creating the FIRST admin only when zero admins exist.
// Checking user_roles (not profiles) closes an escalation window where a
// profile exists but no admin role has been assigned yet.
export const bootstrapFirstAdmin = createServerFn({ method: "POST" })
  .inputValidator((input) => createUserSchema.parse(input))
  .handler(async ({ data }) => {
    const { count: adminCount, error: adminErr } = await supabaseAdmin
      .from("user_roles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "admin");
    if (adminErr) throw new Error(adminErr.message);
    if ((adminCount ?? 0) > 0) throw new Error("Bootstrap is closed; an admin already exists.");

    // Also guard against pre-existing non-admin users to prevent takeover
    // when someone else has been provisioned but no admin role granted.
    const { count: profileCount, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true });
    if (profileErr) throw new Error(profileErr.message);
    if ((profileCount ?? 0) > 0) throw new Error("Bootstrap is closed; users already exist.");

    // Force the bootstrap role to admin no matter what was passed
    return await createUserInternal({ ...data, role: "admin" });
  });

// Admin-only user creation
export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => createUserSchema.parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterIsAdmin(context.userId);
    const result = await createUserInternal(data);
    await logActivity({
      supabaseAdmin,
      actorId: context.userId,
      actorName: await loadActorName(context.userId),
      actorRole: "admin",
      action: "create_user",
      entityType: "profiles",
      metadata: { targetUserId: result.userId, role: data.role },
    });
    return result;
  });

// Admin-only deactivate
export const adminSetActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ userId: z.string().uuid(), isActive: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await ensureRequesterIsAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ is_active: data.isActive })
      .eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    // Also ban/unban auth user
    await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      ban_duration: data.isActive ? "none" : "876000h",
    });
    await logActivity({
      supabaseAdmin,
      actorId: context.userId,
      actorName: await loadActorName(context.userId),
      actorRole: "admin",
      action: "set_user_active",
      entityType: "profiles",
      metadata: { targetUserId: data.userId, isActive: data.isActive },
    });
    return { ok: true };
  });

// Admin-only role change. Admins may set any user to any role. Replaces the
// user's role set with the single chosen role, refuses to demote the last
// remaining admin, and back-fills an access code when switching a user to a
// non-admin role (non-admins sign in with the 6-digit code screen).
export const adminSetRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ userId: z.string().uuid(), role: roleSchema }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await ensureRequesterIsAdmin(context.userId);

    const { data: currentRoles, error: curErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", data.userId);
    if (curErr) throw new Error(curErr.message);
    const roles = (currentRoles ?? []).map((r) => String(r.role));

    // Already exactly this single role — nothing to do.
    if (roles.length === 1 && roles[0] === data.role) {
      return { ok: true, unchanged: true };
    }

    // Never leave the system without an admin.
    if (roles.includes("admin") && data.role !== "admin") {
      const { count, error: cntErr } = await supabaseAdmin
        .from("user_roles")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "admin");
      if (cntErr) throw new Error(cntErr.message);
      if ((count ?? 0) <= 1) {
        throw new Error("Cannot change the role of the last remaining admin.");
      }
    }

    // Add the new role first (so there's never a role-less gap), then drop the
    // rest. Insert only when it isn't already present to avoid unique conflicts.
    if (!roles.includes(data.role)) {
      const { error: insErr } = await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: data.userId, role: data.role });
      if (insErr) throw new Error(insErr.message);
    }
    const { error: delErr } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.userId)
      .neq("role", data.role);
    if (delErr) throw new Error(delErr.message);

    // Non-admins log in via the access-code screen; make sure they have one.
    if (data.role !== "admin") {
      const { data: existingCode } = await supabaseAdmin
        .from("user_access_codes")
        .select("user_id")
        .eq("user_id", data.userId)
        .maybeSingle();
      if (!existingCode) {
        const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
        const { error: codeErr } = await supabaseAdmin
          .from("user_access_codes")
          .upsert(
            { user_id: data.userId, code, verified_session_id: null },
            { onConflict: "user_id" },
          );
        if (codeErr) {
          console.error("[admin-users] Failed to seed access code on role change:", codeErr.message);
        }
      }
    }

    await logActivity({
      supabaseAdmin,
      actorId: context.userId,
      actorName: await loadActorName(context.userId),
      actorRole: "admin",
      action: "set_user_role",
      entityType: "user_roles",
      metadata: { targetUserId: data.userId, role: data.role, previousRoles: roles },
    });

    return { ok: true };
  });

// Admin-only password reset (sets a new password directly)
export const adminResetPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ userId: z.string().uuid(), newPassword: z.string().min(8).max(128) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await ensureRequesterIsAdmin(context.userId);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      password: data.newPassword,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

async function createUserInternal(data: z.infer<typeof createUserSchema>) {
  // Auto-derive username from the email local-part if none was provided, and
  // ensure it's unique by suffixing a number if necessary.
  let username = (data.username ?? deriveUsername(data.email)).toLowerCase();
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? username : `${username}${attempt}`;
    const { data: dupe } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("username", candidate)
      .maybeSingle();
    if (!dupe) {
      username = candidate;
      break;
    }
    if (attempt === 19) throw new Error("Could not generate a unique username from this email.");
  }

  // Create auth user (email auto-confirmed)
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email: data.email,
    password: data.password,
    email_confirm: true,
    user_metadata: { full_name: data.fullName, username },
    ban_duration: data.isActive ? "none" : "876000h",
  });
  if (createErr || !created.user) throw new Error(createErr?.message ?? "Failed to create user");

  const userId = created.user.id;

  // Create profile
  const { error: profErr } = await supabaseAdmin.from("profiles").insert({
    user_id: userId,
    full_name: data.fullName,
    username,
    email: data.email,
    is_active: data.isActive,
  });
  if (profErr) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(profErr.message);
  }

  // Assign role
  const { error: roleErr } = await supabaseAdmin.from("user_roles").insert({
    user_id: userId,
    role: data.role,
  });
  if (roleErr) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(roleErr.message);
  }

  // Generate a personal 6-digit Access Code for non-admin users. Admins log
  // in directly with email/password and don't use the code screen.
  if (data.role !== "admin") {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const { error: codeErr } = await supabaseAdmin
      .from("user_access_codes")
      .upsert({ user_id: userId, code, verified_session_id: null }, { onConflict: "user_id" });
    if (codeErr) {
      // Non-fatal from a create-user standpoint, but surface so admin can retry via regenerate.
      console.error("[admin-users] Failed to seed access code:", codeErr.message);
    }
  }

  return { ok: true, userId };
}
