import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from "./rest";

export interface Env {
  DB?: D1Database;
  DB_PROD: D1Database;
  DB_STAGE: D1Database;
  API_KEY: string;
  BITBUCKET_USERNAME?: string;
  BITBUCKET_WORKSPACE?: string;
  BITBUCKET_FRONT_QUIZ_STATIC_REPO?: string;
  BITBUCKET_API_TOKEN?: string;
}

function isStage(request: Request): boolean {
  const url = new URL(request.url);
  const host = url.hostname;
  const header = request.headers.get("X-Environment");
  const queryEnv = url.searchParams.get("env");
  return (
    host.includes("stage") ||
    header?.toLowerCase() === "stage" ||
    queryEnv?.toLowerCase() === "stage"
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const stage = isStage(request);

    // Define o banco de dados e o contexto baseado no check de stage
    const db = stage ? env.DB_STAGE : env.DB_PROD;

    const effectiveEnv: Env = {
      ...env,
      DB: db,
    };

    const app = new Hono<{ Bindings: Env }>();

    app.use("*", async (c, next) => {
      return cors()(c, next);
    });

    const authMiddleware = async (c: Context, next: Next) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const token = authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : authHeader;

      if (token !== c.env.API_KEY) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      return next();
    };

    app.get("/debug/db", async (c) => {
      try {
        const info = await c.env
          .DB!.prepare("PRAGMA database_list")
          .first<Record<string, unknown>>();
        return c.json({
          database_list: info,
          is_stage: stage, // Útil para confirmar o switch manual
        });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });

    app.all("/rest/*", authMiddleware, handleRest);

    app.post("/query", authMiddleware, async (c) => {
      try {
        const body = await c.req.json();
        const { query, params } = body;

        if (!query) {
          return c.json({ error: "Query is required" }, 400);
        }

        const results = await c.env
          .DB!.prepare(query)
          .bind(...(params || []))
          .all();

        return c.json(results);
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });

    return app.fetch(request, effectiveEnv, ctx);
  },
} satisfies ExportedHandler<Env>;
