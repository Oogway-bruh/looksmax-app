"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Nie udało się zalogować.");
      return;
    }
    const next = params.get("next");
    // Pełne przeładowanie: router Next.js mógł zapamiętać przekierowanie do logowania sprzed zalogowania.
    window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/admin");
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <input
        type="password"
        autoFocus
        autoComplete="current-password"
        placeholder="Hasło"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2"
      />
      {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      <button disabled={busy || !password} className="w-full rounded-lg bg-sky-500 px-4 py-2 font-semibold text-neutral-950 disabled:opacity-50">
        {busy ? "Logowanie…" : "Zaloguj"}
      </button>
    </form>
  );
}
