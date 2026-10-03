import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { applySynthesis, rejectSynthesis, startSynthesis } from "@/lib/knowledge";

export const runtime = "nodejs";

// POST - uruchom analizę wszystkich materiałów (w tle); PUT - zatwierdź propozycję; DELETE - odrzuć.
export async function POST() {
  try {
    return NextResponse.json(await startSynthesis());
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT() {
  try {
    return NextResponse.json(await applySynthesis());
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    await rejectSynthesis();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
