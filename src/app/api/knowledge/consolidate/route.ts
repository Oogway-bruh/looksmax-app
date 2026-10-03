import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { consolidate } from "@/lib/knowledge";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST() {
  try {
    return NextResponse.json(await consolidate());
  } catch (err) {
    return errorResponse(err);
  }
}
