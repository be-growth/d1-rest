import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from "./rest";

// Fetch configuration

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

    // Apply CORS to all routes
    app.use("*", async (c, next) => {
      return cors()(c, next);
    });

    // Authentication middleware that verifies the Authorization header
    // is sent in on each request and matches the value of our API key.
    // If a match is not found we return a 401 and prevent further access.
    const authMiddleware = async (c: Context, next: Next) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const token = authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : authHeader;

      if (token !== env.API_KEY) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      return next();
    };

    // Simple debug route to inspect which D1 database is bound
    app.get("/debug/db", async (c) => {
      try {
        const info = await env.DB.prepare("PRAGMA database_list")
          .first<Record<string, unknown>>();
        return c.json({ database_list: info });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });

    // CRUD REST endpoints made available to all of our tables
    app.all("/rest/*", authMiddleware, handleRest);

    // Execute a raw SQL statement with parameters with this route
    app.post("/query", authMiddleware, async (c) => {
      try {
        const body = await c.req.json();
        const { query, params } = body;

        if (!query) {
          return c.json({ error: "Query is required" }, 400);
        }

        // Execute the query against D1 database
        const results = await env.DB.prepare(query)
          .bind(...(params || []))
          .all();

        return c.json(results);
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    });

    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
