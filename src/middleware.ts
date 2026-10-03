import { NextResponse, type NextRequest } from "next/server";

// Panel administratora i API bazy wiedzy chronione hasłem (HTTP Basic Auth).
// Login dowolny, hasło = ADMIN_PASSWORD. Bez ustawionego hasła panel działa tylko w trybie deweloperskim.
export function middleware(req: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("Ustaw zmienną ADMIN_PASSWORD, aby włączyć panel administratora.", { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = atob(encoded);
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Wymagane logowanie", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Panel bazy wiedzy"' },
  });
}

export const config = { matcher: ["/admin/:path*", "/api/knowledge/:path*"] };
