import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeFace } from "@/lib/analyze";
import { errorResponse } from "@/lib/http";
import { METRIC_KEYS } from "@/lib/metrics";

export const runtime = "nodejs";
export const maxDuration = 300;

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMAGE_CHARS = 7_000_000;

const ImageSchema = z
  .string()
  .max(MAX_IMAGE_CHARS, "Zdjęcie jest za duże.")
  .regex(DATA_URL, "Niepoprawny format zdjęcia.")
  .transform((s) => {
    const [, mediaType, data] = s.match(DATA_URL)!;
    return { mediaType: mediaType as "image/jpeg" | "image/png" | "image/webp", data };
  });

const RequestSchema = z.object({
  frontImage: ImageSchema,
  profileImage: ImageSchema.optional(),
  metrics: z.partialRecord(z.enum(METRIC_KEYS), z.number().finite()),
  spreads: z.partialRecord(z.enum(METRIC_KEYS), z.number().finite().nonnegative()),
  samples: z.number().int().min(1).max(50),
  qualityNotes: z.array(z.string().max(300)).max(20),
  consent: z.literal(true),
});

// Zdjęcia są przetwarzane tylko w pamięci na potrzeby tej analizy - nie zapisujemy ich.
export async function POST(req: Request) {
  try {
    const body = RequestSchema.parse(await req.json());
    const result = await analyzeFace({
      front: body.frontImage,
      profile: body.profileImage,
      metrics: body.metrics,
      spreads: body.spreads,
      samples: body.samples,
      qualityNotes: body.qualityNotes,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, { expose: false });
  }
}
