import { hc } from "hono/client";
import type { AppType } from "../../../server/src/api.ts";

export const client = hc<AppType>("/");
