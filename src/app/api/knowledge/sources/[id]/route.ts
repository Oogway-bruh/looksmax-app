import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { deleteSources } from "@/lib/knowledge";
import { readDb, readSourceFile } from "@/lib/store";

// Podgląd/pobranie oryginalnego pliku.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = (await readDb()).sources.find((s) => s.id === id);
  const data = source && (await readSourceFile(source.storedAs));
  if (!source || !data) return NextResponse.json({ error: "Nie ma takiego pliku." }, { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: {
      // Tekst jako text/plain (bez interpretacji HTML w przeglądarce), pliki biurowe do pobrania.
      "Content-Type": source.kind === "text" && !source.mediaType.includes("officedocument") ? "text/plain; charset=utf-8" : source.mediaType || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(source.filename)}`,
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await deleteSources({ id }));
  } catch (err) {
    return errorResponse(err);
  }
}
