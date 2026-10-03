import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Logowanie" };

export default function LoginPage() {
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
