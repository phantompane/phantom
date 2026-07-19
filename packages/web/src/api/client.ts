import { hc } from "hono/client";
import type { AppType, ApiErrorBody } from "@phantompane/server";

export const configuredApiBaseUrl =
  import.meta.env.VITE_PHANTOM_API_BASE_URL?.trim() || null;
export const defaultApiBaseUrl = configuredApiBaseUrl ?? "/api";

let apiBaseUrl = normalizeApiBaseUrl(defaultApiBaseUrl);

export let api = hc<AppType>(apiBaseUrl);

export function configureApiBaseUrl(value: string): void {
  const nextApiBaseUrl = normalizeApiBaseUrl(value);
  if (nextApiBaseUrl === apiBaseUrl) {
    return;
  }
  apiBaseUrl = nextApiBaseUrl;
  api = hc<AppType>(apiBaseUrl);
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

export function joinApiPath(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function routeParam(value: string): string {
  return encodeURIComponent(value);
}

export function apiUrl(path: string): string {
  return joinApiPath(apiBaseUrl, path);
}

export function normalizeApiBaseUrl(value: string): string {
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue === "/") {
    return "/api";
  }
  return trimmedValue.replace(/\/+$/, "");
}

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
