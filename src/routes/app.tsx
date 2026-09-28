import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuthState } from "@/hooks/use-auth";
import { AppShell } from "@/components/app-shell";
import { ErrorBoundary } from "@/components/error-boundary";
import { AccessCodeGate } from "@/components/access-code-gate";

export const Route = createFileRoute("/app")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  // useAuthState must only be called here — all children use useAuth() from context
  const auth = useAuthState();
  const { loading, session, signOut } = auth;
  const navigate = useNavigate();
  const inactive = auth.profile?.is_active === false;

  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/login" });
      return;
    }
    if (inactive) {
      void signOut();
      navigate({ to: "/login" });
      return;
    }
  }, [loading, session, inactive, signOut, navigate]);

  if (loading || !session || inactive) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!auth.primaryRole) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md text-center bg-card border rounded-lg p-6">
          <h1 className="text-lg font-semibold">No role assigned</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Your account exists but has no role yet. Please contact an administrator.
          </p>
          <button
            onClick={() => void auth.signOut()}
            className="mt-4 text-sm text-primary underline"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Second-step: non-admin users must enter the admin-issued 6-digit access code.
  const isAdmin = auth.roles.includes("admin");
  if (!isAdmin) {
    if (auth.accessCodeChecking && !auth.accessCodeVerified) {
      return (
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (!auth.accessCodeVerified) {
      return <AccessCodeGate auth={auth} />;
    }
  }

  return (
    <AuthProvider value={auth}>
      <AppShell auth={auth}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </AppShell>
    </AuthProvider>
  );
}
