import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { deleteSource } from "@/lib/knowledge";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await deleteSource(id));
  } catch (err) {
    return errorResponse(err);
  }
}
