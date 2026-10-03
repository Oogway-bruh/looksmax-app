import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { applyConsolidation, proposeConsolidation, rejectConsolidation } from "@/lib/knowledge";

export const runtime = "nodejs";
export const maxDuration = 800;

// POST - przygotuj propozycję; PUT - zatwierdź; DELETE - odrzuć.
export async function POST() {
  try {
    return NextResponse.json(await proposeConsolidation());
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT() {
  try {
    return NextResponse.json(await applyConsolidation());
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    await rejectConsolidation();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
