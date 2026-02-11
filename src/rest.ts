import { Context } from "hono";
import type { Env } from "./index";
import { hydrateRow } from "./helpers/index";

/**
 * Sanitizes an identifier by removing all non-alphanumeric characters except underscores.
 */
function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^a-zA-Z0-9_]/g, "");
}

/**
 * Processing when the table name is a keyword in SQLite.
 */
function sanitizeKeyword(identifier: string): string {
  return "`" + sanitizeIdentifier(identifier) + "`";
}

async function handleGet(
  c: Context<{ Bindings: Env }>,
  tableName: string,
  id?: string
): Promise<Response> {
  const table = sanitizeKeyword(tableName);
  const searchParams = new URL(c.req.url).searchParams;
  const idColumn = tableName === "quizzes" ? "slug" : "id";

  try {
    const params: any[] = [];
    const conditions: string[] = [];

    if (id) {
      conditions.push(`${idColumn} = ?`);
      params.push(id);
    }

    for (const [key, value] of searchParams.entries()) {
      if (["sort_by", "order", "limit", "page"].includes(key)) continue;
      conditions.push(`${sanitizeIdentifier(key)} = ?`);
      params.push(value);
    }

    const whereClause =
      conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    const limit = parseInt(searchParams.get("limit") || "0");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const offset = (page - 1) * limit;

    const sortBy = searchParams.get("sort_by") || idColumn;
    const order =
      searchParams.get("order")?.toUpperCase() === "DESC" ? "DESC" : "ASC";

    let query = `SELECT * FROM ${table}${whereClause} ORDER BY ${sanitizeIdentifier(
      sortBy
    )} ${order}`;

    if (limit > 0) {
      query += ` LIMIT ? OFFSET ?`;
      params.push(limit, offset);
    }

    const { results } = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (id) {
      if (!results?.length)
        return c.json({ success: false, error: "Not Found" }, 404);
      return c.json({ success: true, result: hydrateRow(results[0]) });
    }

    const countQuery = `SELECT COUNT(*) as total FROM ${table}${whereClause}`;
    const countParams = limit > 0 ? params.slice(0, -2) : params;
    const { total } = (await c.env.DB.prepare(countQuery)
      .bind(...countParams)
      .first<{ total: number }>()) || { total: 0 };

    return c.json({
      success: true,
      results: results.map(hydrateRow),
      pagination: {
        total_items: total,
        total_pages: limit > 0 ? Math.ceil(total / limit) : 1,
        current_page: page,
        limit: limit || total,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
}

/**
 * Handles POST requests to create new records
 */
async function handlePost(
  c: Context<{ Bindings: Env }>,
  tableName: string
): Promise<Response> {
  const table = sanitizeKeyword(tableName);

  try {
    const data = await c.req.json();

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return c.json({ success: false, error: "Invalid data format" }, 400);
    }

    const columns = Object.keys(data).map(sanitizeIdentifier);
    const placeholders = columns.map(() => "?").join(", ");

    const params = columns.map((col) => {
      const value = data[col];

      if (value !== null && typeof value === "object") {
        return JSON.stringify(value);
      }

      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }

      if (value === undefined || value === null) {
        return null;
      }

      return value;
    });

    const query = `INSERT INTO ${table} (${columns.join(
      ", "
    )}) VALUES (${placeholders})`;

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .run();

    return c.json(
      {
        success: true,
        message: `${tableName} created successfully`,
        id: data.slug || result.meta.last_row_id,
      },
      201
    );
  } catch (error: any) {
    if (error.message.includes("UNIQUE constraint failed")) {
      return c.json(
        { success: false, error: "Este Slug já está em uso." },
        409
      );
    }

    return c.json({ success: false, error: error.message }, 500);
  }
}

/**
 * Handles PUT/PATCH requests to update records
 */
async function handleUpdate(
  c: Context<{ Bindings: Env }>,
  tableName: string,
  id: string
): Promise<Response> {
  const table = sanitizeKeyword(tableName);
  const data = await c.req.json();

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return c.json({ error: "Invalid data format" }, 400);
  }

  try {
    const columns = Object.keys(data).map(sanitizeIdentifier);
    const setColumns = columns.map((col) => `${col} = ?`).join(", ");

    // TRATATIVA DE ENTRADA: Objeto -> String / Boolean -> Number
    const params = columns.map((col) => {
      const value = data[col];
      if (value !== null && typeof value === "object")
        return JSON.stringify(value);
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    });

    // O ID deve ser o último parâmetro para bater com o WHERE id = ?
    const query = `UPDATE ${table} SET ${setColumns} WHERE id = ?`;

    // Nota: Se a tabela for quizzes, use o slug como id na query se necessário
    const idColumn = tableName === "quizzes" ? "slug" : "id";
    const finalQuery = `UPDATE ${table} SET ${setColumns} WHERE ${idColumn} = ?`;

    await c.env.DB.prepare(finalQuery)
      .bind(...params, id)
      .run();

    return c.json({
      success: true,
      message: "Resource updated successfully",
      data,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
}

async function handleDelete(
  c: Context<{ Bindings: Env }>,
  tableName: string,
  id: string
): Promise<Response> {
  const table = sanitizeKeyword(tableName);

  try {
    // Define dinamicamente a coluna de identificação
    const idColumn = tableName === "quizzes" ? "slug" : "id";

    const query = `DELETE FROM ${table} WHERE ${idColumn} = ?`;
    const result = await c.env.DB.prepare(query).bind(id).run();

    // Verifica se algum registro foi realmente afetado
    if (result.meta.changes === 0) {
      return c.json({ error: "Record not found" }, 404);
    }

    return c.json({ success: true, message: "Resource deleted successfully" });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
}

/**
 * Main REST handler that routes requests to appropriate handlers
 */
export async function handleRest(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const url = new URL(c.req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);

  if (pathParts.length < 2) {
    return c.json(
      { error: "Invalid path. Expected format: /rest/{tableName}/{id?}" },
      400
    );
  }

  const tableName = pathParts[1];
  const id = pathParts[2];

  switch (c.req.method) {
    case "GET":
      return handleGet(c, tableName, id);
    case "POST":
      return handlePost(c, tableName);
    case "PUT":
    case "PATCH":
      if (!id) return c.json({ error: "ID is required for updates" }, 400);
      return handleUpdate(c, tableName, id);
    case "DELETE":
      if (!id) return c.json({ error: "ID is required for deletion" }, 400);
      return handleDelete(c, tableName, id);
    default:
      return c.json({ error: "Method not allowed" }, 405);
  }
}
