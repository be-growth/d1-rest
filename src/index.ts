import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from "./rest";

export interface Env {
  DB: D1Database;
  API_KEY: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    const effectiveEnv: Env = {
      ...env,
      DB: env.DB,
    };

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

    app.all("/rest/*", authMiddleware, handleRest);

    app.post("/query", authMiddleware, async (c) => {
      try {
        const body = await c.req.json();
        const { query, params } = body;

        if (!query) {
          return c.json({ error: "Query is required" }, 400);
        }

        const results = await c.env.DB.prepare(query)
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
