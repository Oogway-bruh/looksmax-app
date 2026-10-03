import { NextResponse } from "next/server";
import { readDb } from "@/lib/store";

export const dynamic = "force-dynamic";

// Publiczny status konfiguracji - bez żadnych sekretów, tylko czy są ustawione.
export async function GET() {
  const db = await readDb();
  return NextResponse.json({
    apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    adminPasswordConfigured: Boolean(process.env.ADMIN_PASSWORD?.trim()),
    entries: db.entries.length,
    sources: db.sources.length,
  });
}
