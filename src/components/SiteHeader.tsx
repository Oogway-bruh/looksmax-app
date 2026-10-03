"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Analiza twarzy" },
  { href: "/admin", label: "Baza wiedzy" },
];

export function SiteHeader() {
  const path = usePathname();
  return (
    <header className="border-b border-neutral-900 print:hidden">
      <nav className="mx-auto flex max-w-5xl gap-1 px-4 py-3 text-sm">
        {LINKS.map((l) => {
          const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              // Panel wymaga logowania - bez wczytywania z wyprzedzeniem, żeby nie zapamiętać przekierowania.
              prefetch={l.href === "/admin" ? false : undefined}
              className={`rounded-lg px-3 py-1.5 ${active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
