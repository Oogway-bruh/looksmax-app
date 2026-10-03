import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { addSource, deleteSources } from "@/lib/knowledge";

export const runtime = "nodejs";

// Wgranie materiału (pojedynczy plik, z jego ścieżką w folderach): tylko zapis pliku, bez AI.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku." }, { status: 400 });
    if (file.size > 60 * 1024 * 1024) return NextResponse.json({ error: `Plik ${file.name} jest większy niż 60 MB.` }, { status: 400 });
    const num = (v: FormDataEntryValue | null) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
    const result = await addSource({
      name: file.name,
      path: typeof form.get("path") === "string" ? (form.get("path") as string) : undefined,
      type: file.type,
      data: Buffer.from(await file.arrayBuffer()),
      width: num(form.get("width")),
      height: num(form.get("height")),
    });
    return NextResponse.json({ status: result.status, path: result.path, duplicateOf: result.duplicateOf });
  } catch (err) {
    return errorResponse(err);
  }
}

// Usunięcie całego folderu: DELETE /api/knowledge/sources?folder=Ścieżka/Folderu
export async function DELETE(req: Request) {
  try {
    const folder = new URL(req.url).searchParams.get("folder");
    if (!folder) return NextResponse.json({ error: "Podaj folder." }, { status: 400 });
    return NextResponse.json(await deleteSources({ folder }));
  } catch (err) {
    return errorResponse(err);
  }
}
