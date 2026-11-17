const CUIT_PATTERN = /^\d{11}$/;
const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Validates the format and the check digit (modulo 11) of a CUIT. */
export function isValidCuit(cuit: string): boolean {
  if (!CUIT_PATTERN.test(cuit)) {
    return false;
  }
  const digitAt = (index: number): number => Number(cuit.charAt(index));
  const sum = WEIGHTS.reduce((total, weight, index) => total + weight * digitAt(index), 0);
  const remainder = 11 - (sum % 11);
  // Remainder 11 -> check digit 0. Remainder 10 has no valid check digit: that CUIT does
  // not exist.
  const expected = remainder === 11 ? 0 : remainder;
  return expected !== 10 && digitAt(10) === expected;
}
