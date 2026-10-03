import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ClaudeRefusalError, UserError } from "./errors";

export { UserError } from "./errors";

/**
 * Odpowiedź z błędem. `expose: false` (publiczne API) ukrywa treść nieoczekiwanych błędów
 * (np. komunikaty API z wewnętrznymi szczegółami) - pełny błąd trafia tylko do logów serwera.
 */
export function errorResponse(err: unknown, { expose = true }: { expose?: boolean } = {}) {
  console.error(err);
  if (err instanceof ZodError) return NextResponse.json({ error: "Niepoprawne dane.", details: expose ? err.issues : undefined }, { status: 400 });
  if (err instanceof UserError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ClaudeRefusalError) return NextResponse.json({ error: err.message }, { status: 422 });
  const message = expose && err instanceof Error ? err.message : "Coś poszło nie tak po stronie serwera. Spróbuj ponownie za chwilę.";
  return NextResponse.json({ error: message }, { status: 500 });
}
