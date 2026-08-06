"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
      } else {
        setError("Invalid password");
        setPassword("");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg border border-edge bg-panel p-6 shadow-xl"
      >
        <h1 className="mb-1 text-lg font-semibold tracking-tight">
          Batch Send
        </h1>
        <p className="mb-6 text-xs text-zinc-500">
          Admin access — bulk transfer tool
        </p>

        <label className="mb-2 block text-xs uppercase tracking-wide text-zinc-400">
          Password
        </label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded border border-edge bg-panelalt px-3 py-2 text-sm outline-none focus:border-zinc-500"
          placeholder="••••••••"
        />

        {error && (
          <p className="mb-4 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="w-full rounded bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
