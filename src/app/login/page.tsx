import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SESSION_COOKIE, adminPassword, safeEqual, sessionToken } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Logowanie" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  // Już zalogowany (np. strona przeładowała się zaraz po logowaniu) - od razu do panelu.
  const password = adminPassword();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (password && cookie && safeEqual(cookie, await sessionToken(password))) {
    const next = (await searchParams).next;
    redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/admin");
  }
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-bold">Panel bazy wiedzy</h1>
      <p className="mt-2 mb-6 text-sm text-neutral-400">Wpisz hasło z ADMIN_PASSWORD (plik .env.local).</p>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
