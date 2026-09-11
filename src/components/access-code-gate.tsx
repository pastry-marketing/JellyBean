import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import type { AuthState } from "@/hooks/use-auth";
import jellybeanLogo from "@/assets/jellybean-logo.png";
import { ThemeToggle } from "@/components/theme-toggle";

export function AccessCodeGate({ auth }: { auth: AuthState }) {
  const navigate = useNavigate();
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    inputsRef.current[0]?.focus();
  }, []);

  const code = digits.join("");
  const complete = code.length === 6 && /^\d{6}$/.test(code);

  function setDigit(i: number, v: string) {
    const clean = v.replace(/\D/g, "").slice(0, 1);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = clean;
      return next;
    });
    if (clean && i < 5) inputsRef.current[i + 1]?.focus();
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      inputsRef.current[i - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!text) return;
    e.preventDefault();
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < text.length; i++) next[i] = text[i];
    setDigits(next);
    inputsRef.current[Math.min(text.length, 5)]?.focus();
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc(
        "verify_my_access_code" as never,
        { _code: code } as never,
      );
      if (rpcErr) throw rpcErr;
      if (data === true) {
        auth.markAccessCodeVerified();
        toast.success("Access verified");
      } else {
        setError("Incorrect access code. Please check with your administrator.");
        setDigits(["", "", "", "", "", ""]);
        inputsRef.current[0]?.focus();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || "Verification failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBack() {
    await auth.signOut();
    navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 flex items-center justify-center">
      <ThemeToggle className="fixed right-4 top-4 z-20 h-10 w-10 justify-center border border-border bg-card/80 p-0 shadow-sm backdrop-blur-xl [&>span]:hidden" />
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_22%_14%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_30rem)]" />
      <div className="w-full max-w-md rounded-[28px] border border-border bg-card/90 shadow-lg backdrop-blur-xl p-8 animate-fade-in-up">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-11 w-11 rounded-2xl bg-primary/10 grid place-items-center overflow-hidden">
            <img src={jellybeanLogo} alt="JellyBean" className="h-8 w-8 object-contain" />
          </div>
          <div>
            <div className="text-lg font-semibold tracking-tight">JellyBean</div>
            <div className="text-xs text-muted-foreground">Second-step verification</div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-primary mb-1">
          <ShieldCheck className="h-4 w-4" />
          <p className="text-[12px] font-bold uppercase tracking-[0.12em]">Access Code Required</p>
        </div>
        <h1 className="text-2xl font-bold tracking-[-0.01em]">Enter the 6-digit access code</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter the code provided by your administrator to continue.
        </p>

        <form onSubmit={handleVerify} className="mt-6 space-y-5">
          <div className="flex gap-2 justify-between" onPaste={handlePaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => {
                  inputsRef.current[i] = el;
                }}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={1}
                value={d}
                disabled={submitting}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className="w-11 h-14 text-center text-xl font-semibold tabular-nums rounded-xl border border-border bg-background/70 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              />
            ))}
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full h-11" disabled={!complete || submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying...
              </>
            ) : (
              "Verify Code"
            )}
          </Button>

          <button
            type="button"
            onClick={handleBack}
            className="w-full text-sm text-muted-foreground hover:text-foreground transition"
          >
            Back to login
          </button>
        </form>
      </div>
    </div>
  );
}
