/**
 * Error de regla de negocio. `code` es estable y es lo que la capa HTTP usa para
 * traducirlo a un Problem Detail; el dominio no conoce códigos de estado.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
