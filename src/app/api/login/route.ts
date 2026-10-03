import { NextResponse } from "next/server";
import { SESSION_COOKIE, adminPassword, safeEqual, sessionToken } from "@/lib/auth";

export async function POST(req: Request) {
  const password = adminPassword();
  if (!password) {
    return NextResponse.json(
      { error: "Hasło nie jest ustawione. Dopisz ADMIN_PASSWORD=twoje-hasło w pliku .env.local i uruchom aplikację ponownie." },
      { status: 503 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  const given = typeof body.password === "string" ? body.password.trim() : "";
  if (!safeEqual(given, password)) {
    // Mała zwłoka utrudnia zgadywanie hasła.
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "Nieprawidłowe hasło." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await sessionToken(password), {
    httpOnly: true,
    sameSite: "lax",
    // "Secure" tylko przy HTTPS - inaczej przeglądarka odrzuci ciasteczko przy uruchomieniu lokalnym (http://localhost).
    secure: (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
