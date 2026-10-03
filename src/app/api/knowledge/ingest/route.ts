import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { ingestFile } from "@/lib/knowledge";

export const runtime = "nodejs";
export const maxDuration = 300;

// Jeden plik na żądanie - panel wysyła pliki po kolei i pokazuje postęp.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku." }, { status: 400 });
    if (file.size > 25 * 1024 * 1024) return NextResponse.json({ error: "Plik większy niż 25 MB." }, { status: 400 });
    const result = await ingestFile({ name: file.name, type: file.type, data: Buffer.from(await file.arrayBuffer()) });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
