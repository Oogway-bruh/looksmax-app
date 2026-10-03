import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { DraftEntrySchema } from "@/lib/schema";
import { updateDb } from "@/lib/store";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const draft = DraftEntrySchema.parse(await req.json());
    const entry = await updateDb((db) => {
      const existing = db.entries.find((e) => e.id === id);
      if (!existing) return null;
      // Ręczna poprawka - ponowna analiza materiałów ją zachowa.
      Object.assign(existing, draft, { updatedAt: new Date().toISOString(), manual: true });
      return existing;
    });
    if (!entry) return NextResponse.json({ error: "Nie ma takiego wpisu." }, { status: 404 });
    return NextResponse.json(entry);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await updateDb((db) => {
    db.entries = db.entries.filter((e) => e.id !== id);
  });
  return NextResponse.json({ ok: true });
}
