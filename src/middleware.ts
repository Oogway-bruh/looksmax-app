import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, adminPassword, safeEqual, sessionToken } from "./lib/auth";

// Panel bazy wiedzy i jego API wymagają zalogowania (hasło = ADMIN_PASSWORD).
// Bez ustawionego hasła panel jest otwarty tylko w trybie deweloperskim (npm run dev).
export async function middleware(req: NextRequest) {
  const password = adminPassword();
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  if (!password) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    const msg = "Ustaw zmienną ADMIN_PASSWORD, aby włączyć panel bazy wiedzy.";
    return isApi ? NextResponse.json({ error: msg }, { status: 503 }) : new NextResponse(msg, { status: 503 });
  }
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  if (cookie && safeEqual(cookie, await sessionToken(password))) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: "Zaloguj się ponownie do panelu bazy wiedzy." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/admin/:path*", "/api/knowledge/:path*"] };
