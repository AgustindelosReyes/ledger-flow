const CUIT_PATTERN = /^\d{11}$/;
const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Valida formato y dígito verificador (módulo 11) de un CUIT. */
export function isValidCuit(cuit: string): boolean {
  if (!CUIT_PATTERN.test(cuit)) {
    return false;
  }
  const digitAt = (index: number): number => Number(cuit.charAt(index));
  const sum = WEIGHTS.reduce((total, weight, index) => total + weight * digitAt(index), 0);
  const remainder = 11 - (sum % 11);
  // Resto 11 -> verificador 0. Resto 10 no admite verificador: ese CUIT no existe.
  const expected = remainder === 11 ? 0 : remainder;
  return expected !== 10 && digitAt(10) === expected;
}
