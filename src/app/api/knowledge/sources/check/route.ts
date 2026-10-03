import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { checkUploads } from "@/lib/knowledge";

const Schema = z.object({ files: z.array(z.object({ path: z.string().max(2000), hash: z.string() })).max(20_000) });

// Przed wgraniem folderu: które pliki są bez zmian, które to duplikaty, a które zostały tylko przeniesione.
export async function POST(req: Request) {
  try {
    const { files } = Schema.parse(await req.json());
    return NextResponse.json(await checkUploads(files));
  } catch (err) {
    return errorResponse(err);
  }
}
