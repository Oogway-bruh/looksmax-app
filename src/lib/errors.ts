// Wspólne klasy błędów (bez zależności - żeby uniknąć cykli importów).

/** Błąd, którego treść można pokazać użytkownikowi, z własnym kodem HTTP. */
export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Model odmówił (filtry bezpieczeństwa) także po próbie na modelu zapasowym. */
export class ClaudeRefusalError extends Error {}

/** Odpowiedź modelu została ucięta - za dużo treści do zapisania naraz. */
export class ClaudeTruncatedError extends Error {}
