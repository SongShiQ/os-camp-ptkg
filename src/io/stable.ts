/** Locale-independent UTF-16 code-unit ordering for hashed and serialized data. */
export function compareCanonicalString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
