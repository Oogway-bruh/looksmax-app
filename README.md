# Analiza twarzy według własnej bazy wiedzy

Aplikacja webowa: użytkownik wgrywa zdjęcie twarzy, a dostaje ocenę i listę zmian opartą **wyłącznie na Twojej
bazie wiedzy**, a nie na ogólnie przyjętych kanonach czy wiedzy z internetu.

## Jak to działa

### 1. Skanowanie (przeglądarka, bez AI)
- **Kamera z prowadzeniem** (zalecane): na żywo sprawdza pozę głowy, mimikę, kierunek wzroku, światło, ostrość
  i rozdzielczość. Zdjęcia robią się same, gdy warunki są spełnione; zbiera 6 klatek.
- **Zdjęcia z galerii**: 1-5 zdjęć przodu, każde z oceną jakości; zdjęcia nieużyteczne (np. z uśmiechem) są
  domyślnie pomijane. Opcjonalnie zdjęcie profilu.
- MediaPipe Face Landmarker wykrywa 478 punktów; [`src/lib/metrics.ts`](src/lib/metrics.ts) liczy 21 pomiarów
  (nachylenie oczu, FWHR, midface ratio, ESR, brwi, nos, usta, tercje, żuchwa, kąt brody, asymetria).
- Dokładność: korekta obrotu głowy w 3D (z macierzy transformacji), każde ujęcie skanowane dwa razy (z odbiciem
  lustrzanym) i uśrednione, a z wielu ujęć brana jest mediana z rozrzutem (±).
- Mimika z blendshapes (uśmiech, otwarte usta, zamknięte oczy, uniesione brwi) - bo zmienia proporcje.

### 2. Ocena (serwer)
- **Silnik reguł** ([`src/lib/rules.ts`](src/lib/rules.ts)): wpisy z bazy z przypisanym pomiarem i progami są
  oceniane przez kod; wynik na granicy przedziału (w granicach niepewności) dostaje niższą pewność.
- **Claude** ocenia każdy wpis bazy osobno (oceniono / ogólne zalecenie / niewidoczne), wskazuje, które zalecenia
  z wpisu dotyczą osoby, i nie może używać wiedzy spoza bazy ([`src/lib/analyze.ts`](src/lib/analyze.ts)).
- **Raport liczy kod** ([`src/lib/scoring.ts`](src/lib/scoring.ts)): oceny obszarów i ogólna to średnie ważone
  priorytetem wpisów i pewnością; priorytety zmian wg wpływu = priorytet × (10 - ocena) × pewność; zalecenia
  są pokazywane dosłownie z bazy. Oceny wpisów spoza bazy są odrzucane.

### 3. Raport i historia
Wynik ogólny, najważniejsze zmiany, obszary ze szczegółami, mocne strony, zalecenia ogólne i pomiary.
Zapis do PDF (drukowanie). Historia analiz w przeglądarce z porównaniem dwóch analiz (oceny i pomiary).

## Baza wiedzy (`/admin`)

Ocena opiera się wyłącznie na materiałach autora - aplikacja dopasowuje się do nich, a nie odwrotnie.

1. **Twoje materiały:** wgrywasz pliki (.txt, .md, .csv, .docx, .pdf, zdjęcia notatek/zrzuty ekranu .jpg/.png/.webp),
   wiele naraz lub przeciągając. Pliki są przechowywane w całości w `data/sources/`.
2. **Analiza materiałów:** Claude czyta **wszystkie materiały naraz, w całości** (do ~650 tys. tokenów w jednym
   zapytaniu; większe zbiory są czytane w częściach i składane) i buduje z nich system oceny autora:
   - opis, jak autor ocenia wygląd, i jak przekłada cechy na ocenę,
   - **kategorie autora** (jego nazwy i podział) z wagami w ocenie ogólnej,
   - wszystkie zasady z progami, kryteriami oceny i zaleceniami, z odnośnikiem do plików źródłowych,
   - sprzeczności między materiałami, braki i nieczytelne fragmenty.
   Wynik to propozycja - baza zmienia się dopiero po zatwierdzeniu (kopia trafia do `data/backups/`). Analiza
   działa w tle z podglądem postępu.
3. **System oceny:** podgląd i edycja kategorii (nazwa, waga), ręczna edycja wpisów. Ręczne poprawki są
   zachowywane przy kolejnej analizie materiałów.

Przy analizie twarzy Claude dostaje uporządkowaną bazę, opis systemu oceny autora i - jeśli materiały mają
do ~300 tys. tokenów - **pełne oryginalne materiały** (z cache, więc kolejne analizy są tańsze i szybsze).

Panel jest chroniony hasłem (`ADMIN_PASSWORD`) - strona logowania pod `/login`.

## Uruchomienie lokalne

```bash
npm install            # pobiera też model MediaPipe do public/mediapipe
cp .env.example .env.local   # uzupełnij ANTHROPIC_API_KEY i ADMIN_PASSWORD
npm run dev
```

- http://localhost:3000 - analiza zdjęcia
- http://localhost:3000/admin - baza wiedzy (hasło z `ADMIN_PASSWORD`)

Kamera wymaga HTTPS (lub localhost).

## Testy

```bash
npm test          # pomiary (na prawdziwych danych MediaPipe), jakość zdjęć, reguły, scoring, kategorie, migracja bazy
npm run typecheck
npm run lint
```

## Prywatność

Zdjęcie jest przetwarzane tylko w pamięci na potrzeby jednej analizy i nie jest zapisywane. Użytkownik musi
potwierdzić, że ma 18+ i zgadza się na przetworzenie zdjęcia. Przed publicznym startem potrzebna jest polityka
prywatności (dane biometryczne, art. 9 RODO).

## Wdrożenie - do zrobienia

Baza (`data/db.json`) i materiały (`data/sources/`) są plikami na dysku - działa to na serwerze ze stałym
dyskiem (VPS, Railway, Render z dyskiem). Przy hostingu bez dysku (np. Vercel) trzeba wymienić `src/lib/store.ts`
na Postgres + Storage (np. Supabase). Analiza materiałów działa jako zadanie w tle w procesie serwera, więc
wymaga serwera działającego stale (nie funkcji serverless).
