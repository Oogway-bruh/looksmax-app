import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { slugify } from "@/lib/schema";
import { updateDb } from "@/lib/store";

const CategoriesSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string(), weight: z.number().min(1).max(5) }),
);

// Ręczna edycja kategorii (nazwa, opis, waga). Kategorii z wpisami nie da się usunąć.
export async function PUT(req: Request) {
  try {
    const incoming = CategoriesSchema.parse(await req.json()).map((c) => ({ ...c, id: slugify(c.id) }));
    const categories = await updateDb((db) => {
      const used = new Set(db.entries.map((e) => e.area));
      const missing = [...used].filter((id) => !incoming.some((c) => c.id === id));
      db.categories = [...incoming, ...db.categories.filter((c) => missing.includes(c.id))];
      return db.categories;
    });
    return NextResponse.json(categories);
  } catch (err) {
    return errorResponse(err);
  }
}
