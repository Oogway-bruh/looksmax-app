# Analiza twarzy według własnej bazy wiedzy

Aplikacja webowa: użytkownik wgrywa zdjęcie twarzy, a dostaje ocenę i listę zmian opartą **wyłącznie na Twojej
bazie wiedzy**, a nie na ogólnie przyjętych kanonach czy wiedzy z internetu.

## Jak to działa

1. **Pomiary (przeglądarka, bez AI).** MediaPipe Face Landmarker wykrywa 478 punktów twarzy, a kod liczy
   16 pomiarów: nachylenie oczu, FWHR, midface ratio, ESR, proporcje nosa, ust, tercji i żuchwy, indeks asymetrii
   ([`src/lib/metrics.ts`](src/lib/metrics.ts)).
2. **Silnik reguł (serwer, bez AI).** Wpisy z bazy, które mają przypisany pomiar i progi, są oceniane przez kod -
   deterministycznie i tylko według Twoich progów ([`src/lib/rules.ts`](src/lib/rules.ts)).
3. **Claude (serwer).** Dostaje zdjęcie, pomiary, wyniki reguł i całą bazę wiedzy. Ma zakaz używania wiedzy spoza
   bazy i każde zalecenie musi podpisać ID wpisu (np. `K012`). Kod odrzuca każde zalecenie bez pokrycia w
   istniejących wpisach ([`src/lib/analyze.ts`](src/lib/analyze.ts)).

## Baza wiedzy (`/admin`)

- **Wgrywanie materiałów:** .txt / .md, zdjęcia notatek/grafik, PDF. Claude czyta każdy plik i zamienia go na
  uporządkowane wpisy (obszar, zasada, kryteria oceny, opcjonalnie progi liczbowe, zalecenia, priorytet 1-5),
  bez dodawania czegokolwiek od siebie.
- **Porządkowanie:** przycisk „Uporządkuj bazę” łączy duplikaty z różnych materiałów, oznacza sprzeczności
  (nie rozstrzyga ich za Ciebie) i ustawia priorytety. Przed każdą zmianą kopia bazy trafia do `data/backups/`.
- **Ręczna edycja** każdego wpisu, w tym progów dla pomiarów, oraz eksport/import całej bazy jako JSON.

Baza jest przechowywana w pliku `data/db.json` (poza gitem).

## Uruchomienie lokalne

```bash
npm install            # pobiera też model MediaPipe do public/mediapipe
cp .env.example .env.local   # uzupełnij ANTHROPIC_API_KEY i ADMIN_PASSWORD
npm run dev
```

- http://localhost:3000 - analiza zdjęcia
- http://localhost:3000/admin - baza wiedzy (hasło z `ADMIN_PASSWORD`; w trybie dev bez hasła)

## Prywatność

Zdjęcie jest przetwarzane tylko w pamięci na potrzeby jednej analizy i nie jest zapisywane. Użytkownik musi
potwierdzić, że ma 18+ i zgadza się na przetworzenie zdjęcia. Przed publicznym startem potrzebna jest polityka
prywatności (dane biometryczne, art. 9 RODO).

## Wdrożenie - do zrobienia

Plikowa baza działa na serwerze ze stałym dyskiem (VPS, Railway, Render z dyskiem). Przy hostingu bez dysku
(np. Vercel) trzeba wymienić `src/lib/store.ts` na Postgresa (np. Supabase) - reszta kodu korzysta tylko z
funkcji `readDb` / `updateDb`.
