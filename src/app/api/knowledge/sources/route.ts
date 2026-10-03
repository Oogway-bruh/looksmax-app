import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { addSource } from "@/lib/knowledge";

export const runtime = "nodejs";

// Wgranie materiału: tylko zapis pliku (bez AI). Analiza wszystkich materiałów to osobny krok.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku." }, { status: 400 });
    if (file.size > 30 * 1024 * 1024) return NextResponse.json({ error: `Plik ${file.name} jest większy niż 30 MB.` }, { status: 400 });
    const source = await addSource({ name: file.name, type: file.type, data: Buffer.from(await file.arrayBuffer()) });
    return NextResponse.json(source);
  } catch (err) {
    return errorResponse(err);
  }
}
