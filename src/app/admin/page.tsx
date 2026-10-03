import { KnowledgeAdmin } from "@/components/KnowledgeAdmin";

export const metadata = { title: "Baza wiedzy" };

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-bold">Baza wiedzy</h1>
      <p className="mt-2 mb-8 text-neutral-400">Tu wgrywasz swoje materiały i zarządzasz wiedzą, z której korzysta analiza.</p>
      <KnowledgeAdmin />
    </main>
  );
}
