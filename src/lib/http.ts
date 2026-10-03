import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ClaudeRefusalError } from "./claude";

/** Błąd, którego treść można pokazać użytkownikowi, z własnym kodem HTTP. */
export class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function errorResponse(err: unknown) {
  console.error(err);
  if (err instanceof ZodError) return NextResponse.json({ error: "Niepoprawne dane.", details: err.issues }, { status: 400 });
  if (err instanceof UserError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ClaudeRefusalError) return NextResponse.json({ error: err.message }, { status: 422 });
  const message = err instanceof Error ? err.message : "Nieznany błąd";
  return NextResponse.json({ error: message }, { status: 500 });
}
