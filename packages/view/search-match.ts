/** Browser-safe deterministic compiler for the keyword expression shared by Search contracts and SQLite. */
export function compileViewSearchMatchExpression(input: string): string {
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unique = [...new Set(tokens.map(token => token.toLocaleLowerCase("und")))];
  if (unique.length === 0) throw new TypeError("search text must contain at least one letter, number, or underscore token");
  return unique.map(token => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}
