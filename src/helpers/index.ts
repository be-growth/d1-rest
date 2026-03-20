/**
 * Converte valores do D1 (Strings JSON, 0/1) para tipos nativos do JS.
 */
function hydrateValue<T = any>(value: any): T {
  // 1. Check imediato para nulos/indefinidos
  if (value === null || value === undefined) return value;

  // 2. Parse de JSON apenas se for string e tiver estrutura de objeto/array
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

const BOOLEAN_KEYS = new Set([
  // Quiz flags
  "rtl",
  "show_welcome",
  "show_timer",
  "gtm",
  "requiresWhatsapp",
  // Question flags
  "redirectable",
]);

/**
 * Hidrata uma linha inteira do banco de dados.
 */
export function hydrateRow<T = any>(row: Record<string, any>): T {
  if (!row) return row as T;

  // Usamos Object.fromEntries para uma sintaxe mais limpa e funcional
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      // D1 frequentemente salva booleans como 0/1.
      // Para evitar quebrar campos numéricos (ex: min=1), só convertemos chaves
      // explicitamente conhecidas como flags booleanas.
      if (
        typeof value === "number" &&
        (value === 0 || value === 1) &&
        BOOLEAN_KEYS.has(key)
      ) {
        return [key, value === 1];
      }

      return [key, hydrateValue(value)];
    })
  ) as T;
}
