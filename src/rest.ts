import { Context } from "hono";
import type { Env } from "./index";
import { hydrateRow } from "./helpers/index";

async function triggerFrontQuizStaticBuild(
  c: Context<{ Bindings: Env }>,
  branch: string
) {
  const env = c.env;
  const token = env.BITBUCKET_API_TOKEN;

  if (!token) {
    console.log("Bitbucket trigger skipped: missing token");
    return;
  }

  const url = `https://api.bitbucket.org/2.0/repositories/tech-utua/front-quiz-static/pipelines/`;

  const authHeader = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target: {
          type: "pipeline_ref_target",
          ref_type: "branch",
          ref_name: branch,
        },
      }),
    });

    console.log(`Bitbucket pipeline triggered for branch: ${branch}`, {
      status: res.status,
    });
  } catch (error) {
    console.error("Bitbucket trigger failed", error);
  }
}

function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^a-zA-Z0-9_]/g, "");
}

function sanitizeKeyword(identifier: string): string {
  return "`" + sanitizeIdentifier(identifier) + "`";
}

function getTargetBranch(c: Context): string {
  const url = new URL(c.req.url);
  return url.hostname.includes("-stage") ? "stage" : "main";
}

function normalizeForSearch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;

  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  // Use apenas duas linhas para reduzir memória.
  const prev = new Array(bLen + 1).fill(0);
  const curr = new Array(bLen + 1).fill(0);

  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }

    for (let j = 0; j <= bLen; j++) prev[j] = curr[j];
  }

  return prev[bLen];
}

function fuzzyScore(queryRaw: string, candidateRaw: unknown, options?: { strict?: boolean }) {
  const candidate = typeof candidateRaw === "string" ? candidateRaw : "";
  const query = normalizeForSearch(queryRaw);
  const target = normalizeForSearch(candidate);

  if (!query || !target) return 0;
  if (query === target) return 1;

  if (target.includes(query)) return options?.strict ? 0.85 : 0.78;
  if (query.includes(target)) return options?.strict ? 0.7 : 0.65;

  // Matching por tokens (melhora busca por título com várias palavras).
  const queryTokens = query.split(/\s+/).filter(Boolean);
  if (queryTokens.length > 1 && queryTokens.every((t) => target.includes(t))) {
    return options?.strict ? 0.65 : 0.6;
  }

  const dist = levenshteinDistance(query, target);
  const maxLen = Math.max(query.length, target.length) || 1;
  return 1 - dist / maxLen;
}

function parseQuestionIdParts(questionId: string): { lang?: string; index: number } | null {
  const base = questionId.trim();
  const matchNoLang = base.match(/^question-(\d+)$/);
  if (matchNoLang) return { index: Number(matchNoLang[1]) };

  const matchWithLang = base.match(/^question-([a-z]{2})-(\d+)$/i);
  if (matchWithLang) return { lang: matchWithLang[1].toLowerCase(), index: Number(matchWithLang[2]) };

  return null;
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

    const titleQuery = tableName === "questions" && !id ? searchParams.get("title") : null;
    const slugQuery = tableName === "quizzes" && !id ? searchParams.get("slug") : null;
    const fuzzyMode = Boolean(titleQuery) || Boolean(slugQuery);

    if (id) {
      conditions.push(`${idColumn} = ?`);
      params.push(id);
    }

    for (const [key, value] of searchParams.entries()) {
      if (["sort_by", "order", "limit", "page"].includes(key)) continue;
      if (fuzzyMode && tableName === "questions" && key === "title" && titleQuery) continue;
      if (fuzzyMode && tableName === "quizzes" && key === "slug" && slugQuery) continue;
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

    let query = `SELECT * FROM ${table}${whereClause} ORDER BY ${sanitizeIdentifier(sortBy)} ${order}`;

    if (!fuzzyMode && limit > 0) {
      query += ` LIMIT ? OFFSET ?`;
      params.push(limit, offset);
    }

    const { results } = await c.env.DB.prepare(query).bind(...params).all();

    if (id) {
      if (!results?.length)
        return c.json({ success: false, error: "Not Found" }, 404);
      return c.json({ success: true, result: hydrateRow(results[0]) });
    }

    const hydratedResults = results.map(hydrateRow);

    if (fuzzyMode) {
      const scored =
        titleQuery &&
        tableName === "questions"
          ? hydratedResults
              .map((row) => ({
                row,
                score: fuzzyScore(titleQuery, row.title, { strict: true }),
              }))
              .filter((r) => r.score >= 0.4)
          : slugQuery && tableName === "quizzes"
            ? hydratedResults.map((row) => ({
                row,
                score: fuzzyScore(slugQuery, row.slug, { strict: false }),
              })).filter((r) => r.score >= 0.45)
            : hydratedResults.map((row) => ({ row, score: 0 }));

      scored.sort((a, b) => b.score - a.score);

      const total = scored.length;
      const paginated =
        limit > 0
          ? scored.slice(offset, offset + limit).map((r) => r.row)
          : scored.map((r) => r.row);

      return c.json({
        success: true,
        results: paginated,
        pagination: {
          total_items: total,
          total_pages: limit > 0 ? Math.ceil(total / limit) : 1,
          current_page: page,
          limit: limit || total,
        },
      });
    }

    const countQuery = `SELECT COUNT(*) as total FROM ${table}${whereClause}`;
    const countParams = limit > 0 ? params.slice(0, -2) : params;
    const { total } = (await c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>()) || {
      total: 0,
    };

    return c.json({
      success: true,
      results: hydratedResults,
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

    if (tableName === "questions") {
      const questionData = data as Record<string, any>;

      // 1) Gerar ID da question caso o client não tenha enviado.
      if (!questionData.id || typeof questionData.id !== "string") {
        const rawLang = typeof questionData.lang === "string" ? questionData.lang : "";
        const normalizedLang = rawLang.trim().toLowerCase();
        const langCode = normalizedLang.match(/([a-z]{2})$/)?.[1]; // ex: "pt-br" -> "br"

        const { results: existing } = await c.env.DB.prepare("SELECT id FROM questions").all();
        const existingIds: string[] = (existing || []).map((r: any) => r.id).filter(Boolean);

        const indices = existingIds
          .map(parseQuestionIdParts)
          .filter((p): p is { lang?: string; index: number } => Boolean(p))
          .filter((p) => (langCode ? p.lang === langCode : !p.lang))
          .map((p) => p.index);

        const nextIndex = (Math.max(...indices, 0) || 0) + 1;
        const nextQuestionId = langCode ? `question-${langCode}-${nextIndex}` : `question-${nextIndex}`;
        questionData.id = nextQuestionId;
      }

      // 2) Gerar ID das options a partir do ID da question e da ordem.
      if (Array.isArray(questionData.options)) {
        questionData.options = questionData.options.map((opt: any, index: number) => {
          if (!opt || typeof opt !== "object") return opt;
          if (!opt.id || typeof opt.id !== "string") {
            opt.id = `${questionData.id}-${index + 1}`;
          }
          return opt;
        });
      }
    }

    const columns = Object.keys(data).map(sanitizeIdentifier);
    const placeholders = columns.map(() => "?").join(", ");

    const params = columns.map((col) => {
      const value = data[col];
      if (value !== null && typeof value === "object")
        return JSON.stringify(value);
      if (typeof value === "boolean") return value ? 1 : 0;
      if (value === undefined || value === null) return null;
      return value;
    });

    const query = `INSERT INTO ${table} (${columns.join(
      ", "
    )}) VALUES (${placeholders})`;

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .run();

    if (tableName === "quizzes" || tableName === "questions") {
      const branch = getTargetBranch(c);
      c.executionCtx.waitUntil(triggerFrontQuizStaticBuild(c, branch));
    }

    return c.json(
      {
        success: true,
        message: `${tableName} created successfully`,
        id:
          tableName === "questions"
            ? (data as any).id
            : (data as any).slug || result.meta.last_row_id,
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

    const params = columns.map((col) => {
      const value = data[col];
      if (value !== null && typeof value === "object")
        return JSON.stringify(value);
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    });

    const idColumn = tableName === "quizzes" ? "slug" : "id";
    const finalQuery = `UPDATE ${table} SET ${setColumns} WHERE ${idColumn} = ?`;

    await c.env.DB.prepare(finalQuery)
      .bind(...params, id)
      .run();

    if (tableName === "quizzes" || tableName === "questions") {
      const branch = getTargetBranch(c);
      c.executionCtx.waitUntil(triggerFrontQuizStaticBuild(c, branch));
    }

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
    const idColumn = tableName === "quizzes" ? "slug" : "id";
    const query = `DELETE FROM ${table} WHERE ${idColumn} = ?`;
    const result = await c.env.DB.prepare(query).bind(id).run();

    if (result.meta.changes === 0) {
      return c.json({ error: "Record not found" }, 404);
    }

    if (tableName === "quizzes" || tableName === "questions") {
      const branch = getTargetBranch(c);
      c.executionCtx.waitUntil(triggerFrontQuizStaticBuild(c, branch));
    }

    return c.json({ success: true, message: "Resource deleted successfully" });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
}

async function handleDeleteQuestionsBulk(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const body = await c.req.json();
    const ids = body?.ids;

    if (!Array.isArray(ids) || ids.some((v: unknown) => typeof v !== "string")) {
      return c.json({ success: false, error: "Invalid payload. Expected { ids: string[] }" }, 400);
    }

    if (!ids.length) {
      return c.json({ success: true, deleted: 0, message: "No ids provided" });
    }

    const placeholders = ids.map(() => "?").join(", ");
    const query = `DELETE FROM questions WHERE id IN (${placeholders})`;
    const result = await c.env.DB.prepare(query).bind(...ids).run();

    if (result.meta.changes > 0) {
      const branch = getTargetBranch(c);
      c.executionCtx.waitUntil(triggerFrontQuizStaticBuild(c, branch));
    }

    return c.json({
      success: true,
      deleted: result.meta.changes,
      message: "Questions deleted successfully",
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
}

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
      if (!id) {
        if (tableName === "questions") return handleDeleteQuestionsBulk(c);
        return c.json({ error: "ID is required for deletion" }, 400);
      }
      return handleDelete(c, tableName, id);
    default:
      return c.json({ error: "Method not allowed" }, 405);
  }
}
