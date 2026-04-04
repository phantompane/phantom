import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const healthQuerySchema = z.object({
  name: z.string().min(1).optional(),
});

export const api = new Hono()
  .basePath("/api")
  .get("/health", zValidator("query", healthQuerySchema), (c) => {
    const { name } = c.req.valid("query");

    return c.json({
      ok: true,
      message: name ? `Hello, ${name}` : "Phantom server is healthy",
      runtime: "hono",
    });
  });

export type AppType = typeof api;
