/**
 * Business rule error. `code` is stable and is what the HTTP layer uses to translate it
 * into a Problem Detail; the domain knows nothing about status codes.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
