// Hardcoded authentication fixture. A Map (not a plain object) so tokens like
// "constructor" or "__proto__" cannot match inherited properties.
const OPERATOR_BY_TOKEN = new Map<string, string>([
  ["test-token-a", "operator-a"],
  ["test-token-b", "operator-b"],
]);

/** Returns the operator authorized by an `Authorization` header, or null. */
export function operatorForAuthHeader(header: string | undefined): string | null {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  return (match && OPERATOR_BY_TOKEN.get(match[1]!)) ?? null;
}
