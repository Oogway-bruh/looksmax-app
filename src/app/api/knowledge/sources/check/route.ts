import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { checkUploads } from "@/lib/knowledge";

const Schema = z.object({
  files: z.array(z.object({ path: z.string().max(2000), hash: z.string() })).max(20_000),
  // Foldery wgrywane w całości - tylko z nich plik może zostać „przeniesiony”.
  roots: z.array(z.string().max(500)).max(100).default([]),
});

// Przed wgraniem folderu: które pliki są bez zmian, które to duplikaty, a które zostały tylko przeniesione.
export async function POST(req: Request) {
  try {
    const { files, roots } = Schema.parse(await req.json());
    return NextResponse.json(await checkUploads(files, roots));
  } catch (err) {
    return errorResponse(err);
  }
}
