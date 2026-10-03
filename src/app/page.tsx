import { FaceAnalyzer } from "@/components/FaceAnalyzer";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-bold">Analiza twarzy</h1>
      <p className="mt-2 mb-8 text-neutral-400">
        Wgraj zdjęcie twarzy, a dostaniesz ocenę i listę zmian opartą wyłącznie na autorskiej bazie wiedzy.
      </p>
      <FaceAnalyzer />
    </main>
  );
}
