import { readDb } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await readDb();
  return new Response(JSON.stringify(db, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="baza-wiedzy-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
