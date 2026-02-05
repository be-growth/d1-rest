/**
 * Converte valores do D1 (Strings JSON, 0/1) para tipos nativos do JS.
 */
function hydrateValue<T = any>(value: any): T {
  // 1. Check imediato para nulos/indefinidos
  if (value === null || value === undefined) return value;

  // 2. Tratativa estrita para Booleans (D1 usa 0 e 1)
  // Nota: Verificamos o nome da coluna ou contexto se necessário,
  // mas como o SQLite é dinâmico, 0/1 costumam ser booleans em flags.
  if (value === 0) return false as any;
  if (value === 1) return true as any;

  // 3. Parse de JSON apenas se for string e tiver estrutura de objeto/array
  if (typeof value === "string") {
    const firstChar = value[0];
    if (firstChar === "{" || firstChar === "[") {
      try {
        return JSON.parse(value);
      } catch {
        return value as any;
      }
    }
  }

  return value;
}

/**
 * Hidrata uma linha inteira do banco de dados.
 */
export function hydrateRow<T = any>(row: Record<string, any>): T {
  if (!row) return row as T;

  // Usamos Object.fromEntries para uma sintaxe mais limpa e funcional
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, hydrateValue(value)])
  ) as T;
}
