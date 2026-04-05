import { Hono } from "hono";

export const rpcApp = new Hono().get("/status", (c) => c.json({}));

export const app = new Hono().route("/api/rpc", rpcApp);

export type AppType = typeof app;
