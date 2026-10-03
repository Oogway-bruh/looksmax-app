import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { DraftEntrySchema } from "@/lib/schema";
import { newEntry, updateDb } from "@/lib/store";

// Ręczne dodanie wpisu z panelu.
export async function POST(req: Request) {
  try {
    const draft = DraftEntrySchema.parse(await req.json());
    const entry = await updateDb((db) => {
      const e = newEntry(db, draft, [], true);
      db.entries.push(e);
      return e;
    });
    return NextResponse.json(entry);
  } catch (err) {
    return errorResponse(err);
  }
}
