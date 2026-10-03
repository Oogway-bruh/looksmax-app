import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { reconcileUpload } from "@/lib/knowledge";

const Schema = z.object({
  roots: z.array(z.string().max(500)).max(100),
  uploaded: z.array(z.string().max(2000)).max(20_000),
  unreadable: z.array(z.string().max(2000)).max(20_000).default([]),
  moves: z.array(z.object({ from: z.string().max(2000), to: z.string().max(2000) })).max(20_000),
});

// Po wgraniu folderu: przeniesienia plików i lista materiałów, których nie ma już w nowej wersji folderu.
export async function POST(req: Request) {
  try {
    return NextResponse.json(await reconcileUpload(Schema.parse(await req.json())));
  } catch (err) {
    return errorResponse(err);
  }
}
