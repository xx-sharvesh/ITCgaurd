"use client";

/**
 * The sign-in form.
 *
 * Holds no security logic — it POSTs a candidate and renders whatever the
 * server says. Every decision that matters is made in the login route. The
 * one security-relevant behaviour here is what it does NOT do: it never
 * stores the password, never puts a token in localStorage, and never reads
 * the session cookie (it cannot — the cookie is httpOnly).
 */

import { useCallback, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Loader2, LogIn } from "lucide-react";
import { Button } from "./primitives";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);

      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const json = await res.json().catch(() => ({ ok: false, error: "Unexpected server response." }));

        if (!json.ok) {
          setError(json.error ?? "Sign-in failed.");
          setPassword("");
          setBusy(false);
          return;
        }

        // Only ever navigate to a relative in-app path. A caller-supplied
        // absolute URL here would be an open-redirect, handing an attacker a
        // convincing phishing hop off our own domain.
        const next = params.get("next");
        const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

        router.replace(safeNext);
        router.refresh();
      } catch {
        setError("Could not reach the server. Check that the app is still running.");
        setBusy(false);
      }
    },
    [username, password, params, router],
  );

  return (
    <div className="w-full max-w-[380px]">
      <div className="mb-7 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-md bg-[var(--color-navy)] text-[14px] font-bold text-white">
          ₹
        </span>
        <span className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)]">ITC Guard</span>
      </div>

      <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-[var(--color-ink)]">
        Sign in
      </h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
        Your reconciliation data stays in this browser. This sign-in protects access to the
        application itself.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        <div>
          <label
            htmlFor="username"
            className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-muted)]"
          >
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            autoFocus
            disabled={busy}
            className="h-10 w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 text-[14px] text-[var(--color-ink)]"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-muted)]"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
            className="h-10 w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 text-[14px] text-[var(--color-ink)]"
          />
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger-line)] bg-[var(--color-danger-bg)] px-3.5 py-3 text-[12.5px] leading-snug text-[var(--color-danger)]"
          >
            <AlertCircle size={15} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        <Button type="submit" variant="primary" icon={busy ? Loader2 : LogIn} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-8 border-t border-[var(--color-line)] pt-5 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
        Looking to see the product first?{" "}
        <a href="/demo" className="font-medium text-[var(--color-ink)] underline-offset-2 hover:underline">
          Open the sample-data demo
        </a>{" "}
        — no sign-in needed.
      </p>
    </div>
  );
}
