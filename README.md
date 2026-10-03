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

- **Wgrywanie materiałów:** .txt / .md, zdjęcia notatek/grafik, PDF - wiele naraz. Claude zamienia każdy plik
  na wpisy (obszar, zasada, kryteria oceny, opcjonalnie progi liczbowe, zalecenia, priorytet 1-5), bez dodawania
  czegokolwiek od siebie.
- **Porządkowanie:** łączy duplikaty (osobno w każdym obszarze, więc działa przy dużych bazach), oznacza
  sprzeczności i ustawia priorytety. Najpierw pokazuje **propozycję** (co połączono, co zostanie usunięte) -
  baza zmienia się dopiero po zatwierdzeniu; kopia trafia do `data/backups/`.
- **Pokrycie bazy:** ile wpisów ma każdy obszar, które pomiary mają progi, którym wpisom brakuje kryteriów lub zaleceń.
- Ręczna edycja wpisów (w tym progów), usuwanie materiałów, eksport/import JSON.

Baza jest przechowywana w pliku `data/db.json` (poza gitem).

## Uruchomienie lokalne

```bash
npm install            # pobiera też model MediaPipe do public/mediapipe
cp .env.example .env.local   # uzupełnij ANTHROPIC_API_KEY i ADMIN_PASSWORD
npm run dev
```

- http://localhost:3000 - analiza zdjęcia
- http://localhost:3000/admin - baza wiedzy (hasło z `ADMIN_PASSWORD`; w trybie dev bez hasła)

Kamera wymaga HTTPS (lub localhost).

## Testy

```bash
npm test          # pomiary (na prawdziwych danych MediaPipe), jakość zdjęć, reguły i scoring
npm run typecheck
npm run lint
```

## Prywatność

Zdjęcie jest przetwarzane tylko w pamięci na potrzeby jednej analizy i nie jest zapisywane. Użytkownik musi
potwierdzić, że ma 18+ i zgadza się na przetworzenie zdjęcia. Przed publicznym startem potrzebna jest polityka
prywatności (dane biometryczne, art. 9 RODO).

## Wdrożenie - do zrobienia

Plikowa baza działa na serwerze ze stałym dyskiem (VPS, Railway, Render z dyskiem). Przy hostingu bez dysku
(np. Vercel) trzeba wymienić `src/lib/store.ts` na Postgresa (np. Supabase) - reszta kodu korzysta tylko z
funkcji `readDb` / `updateDb`.
