import { hc } from "hono/client";
import type { AppType, ApiErrorBody } from "@phantompane/server";

const apiBaseUrl = import.meta.env.VITE_PHANTOM_API_BASE_URL ?? "/api";

export const api = hc<AppType>(apiBaseUrl);

export async function readRpcJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorBody = data as Partial<ApiErrorBody>;
    const message = errorBody.error?.message
      ? errorBody.error.message
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}
