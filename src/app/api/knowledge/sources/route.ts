import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { addSource, deleteSources } from "@/lib/knowledge";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 60 * 1024 * 1024;

// Wgranie materiału (pojedynczy plik, z jego ścieżką w folderach): zapis + przygotowanie (obrazy, PDF), bez AI.
export async function POST(req: Request) {
  try {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES + 1024 * 1024) return NextResponse.json({ error: "Plik jest większy niż 60 MB - podziel go na mniejsze części." }, { status: 413 });
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Nie udało się odebrać pliku (za duży lub przerwane połączenie)." }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku." }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: `Plik ${file.name} jest większy niż 60 MB.` }, { status: 413 });
    const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : undefined);
    const result = await addSource({
      name: file.name,
      path: str(form.get("path")),
      type: file.type,
      data: Buffer.from(await file.arrayBuffer()),
      originalHash: str(form.get("originalHash")),
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const DeleteSchema = z.object({ ids: z.array(z.string()).min(1).max(10_000) });

// Usunięcie całego folderu (?folder=Ścieżka) albo listy plików (treść: { ids: [...] }).
export async function DELETE(req: Request) {
  try {
    const folder = new URL(req.url).searchParams.get("folder");
    if (folder) return NextResponse.json(await deleteSources({ folder }));
    const { ids } = DeleteSchema.parse(await req.json().catch(() => ({})));
    return NextResponse.json(await deleteSources({ ids }));
  } catch (err) {
    return errorResponse(err);
  }
}
