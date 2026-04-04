import { hc } from "hono/client";
import type { AppType } from "../../server/api.ts";

export const client = hc<AppType>("/");
