import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeFace } from "@/lib/analyze";
import { errorResponse } from "@/lib/http";
import { METRIC_KEYS } from "@/lib/metrics";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  image: z.string().regex(/^data:image\/(jpeg|png|webp);base64,/),
  metrics: z.partialRecord(z.enum(METRIC_KEYS), z.number()),
  warnings: z.array(z.string()).max(10),
  consent: z.literal(true),
});

// Zdjęcie jest przetwarzane tylko w pamięci na potrzeby tej analizy - nie zapisujemy go.
export async function POST(req: Request) {
  try {
    const body = RequestSchema.parse(await req.json());
    const [, mediaType, data] = body.image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.*)$/s)!;
    if (data.length > 7_000_000) return NextResponse.json({ error: "Zdjęcie jest za duże." }, { status: 400 });
    const result = await analyzeFace({
      imageBase64: data,
      mediaType: mediaType as "image/jpeg" | "image/png" | "image/webp",
      metrics: body.metrics,
      warnings: body.warnings,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
