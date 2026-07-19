export const connectionStorageKey = "phantom.connections:v1";

export type ConnectionProtocol = "http" | "https";

export interface ConnectionInput {
  host: string;
  name?: string;
  port?: string;
  protocol: string;
}

export interface NormalizedConnectionInput {
  host: string;
  name: string | null;
  port: number | null;
  protocol: ConnectionProtocol;
}

export interface SavedConnection extends NormalizedConnectionInput {
  id: string;
}

export interface ConnectionStore {
  activeConnectionId: string | null;
  connections: SavedConnection[];
  version: 1;
}

export type ConnectionField = "form" | "host" | "name" | "port" | "protocol";

export type ConnectionFieldErrors = Partial<Record<ConnectionField, string>>;

export type ConnectionValidationResult =
  | {
      errors: ConnectionFieldErrors;
      ok: false;
    }
  | {
      ok: true;
      value: NormalizedConnectionInput;
    };

export const emptyConnectionStore: ConnectionStore = {
  activeConnectionId: null,
  connections: [],
  version: 1,
};

export function validateConnectionInput(
  input: ConnectionInput,
): ConnectionValidationResult {
  const errors: ConnectionFieldErrors = {};
  const name = input.name?.trim() ?? "";
  const rawHost = input.host.trim();
  const rawPort = input.port?.trim() ?? "";
  const protocol = input.protocol.trim().toLowerCase();

  if (name.length > 80) {
    errors.name = "Name must be 80 characters or fewer.";
  }

  if (protocol !== "http" && protocol !== "https") {
    errors.protocol = "Choose HTTP or HTTPS.";
  }

  let port: number | null = null;
  if (rawPort) {
    if (!/^\d+$/.test(rawPort)) {
      errors.port = "Port must be a whole number.";
    } else {
      port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        errors.port = "Port must be between 1 and 65535.";
      }
    }
  }

  let host: string | null = null;
  if (!rawHost) {
    errors.host = "Host is required.";
  } else if (/\s/.test(rawHost)) {
    errors.host = "Host cannot contain spaces.";
  } else if (rawHost.includes("://")) {
    errors.host = "Enter the host only, without http:// or https://.";
  } else if (/[/?#@]/.test(rawHost)) {
    errors.host =
      "Host cannot include a path, query, fragment, or credentials.";
  } else {
    const hostResult = normalizeHost(rawHost);
    if (hostResult.ok) {
      host = hostResult.host;
    } else {
      errors.host = hostResult.message;
    }
  }

  if (Object.keys(errors).length > 0 || !host) {
    return { errors, ok: false };
  }

  return {
    ok: true,
    value: {
      host,
      name: name || null,
      port,
      protocol: protocol as ConnectionProtocol,
    },
  };
}

export function createSavedConnection(
  id: string,
  input: NormalizedConnectionInput,
): SavedConnection {
  return { id, ...input };
}

export function getConnectionOrigin(
  connection: NormalizedConnectionInput,
): string {
  const url = new URL(`${connection.protocol}://${connection.host}`);
  if (connection.port !== null) {
    url.port = String(connection.port);
  }
  return url.origin;
}

export function getConnectionApiBaseUrl(
  connection: NormalizedConnectionInput,
): string {
  return `${getConnectionOrigin(connection)}/api`;
}

export function getConnectionDisplayName(
  connection: NormalizedConnectionInput,
): string {
  if (connection.name) {
    return connection.name;
  }
  return connection.port === null
    ? connection.host
    : `${connection.host}:${connection.port}`;
}

export function getConnectionEndpointLabel(
  connection: NormalizedConnectionInput,
): string {
  return getConnectionOrigin(connection);
}

export function parseConnectionStore(rawValue: string | null): ConnectionStore {
  if (!rawValue) {
    return emptyConnectionStore;
  }

  try {
    const value = JSON.parse(rawValue) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.connections)
    ) {
      return emptyConnectionStore;
    }

    const connections: SavedConnection[] = [];
    const ids = new Set<string>();
    const apiBaseUrls = new Set<string>();
    for (const candidate of value.connections) {
      if (!isRecord(candidate) || typeof candidate.id !== "string") {
        continue;
      }
      const id = candidate.id.trim();
      if (!id || ids.has(id)) {
        continue;
      }

      const validation = validateConnectionInput({
        host: typeof candidate.host === "string" ? candidate.host : "",
        name: typeof candidate.name === "string" ? candidate.name : "",
        port:
          typeof candidate.port === "number" ||
          typeof candidate.port === "string"
            ? String(candidate.port)
            : "",
        protocol:
          typeof candidate.protocol === "string" ? candidate.protocol : "",
      });
      if (!validation.ok) {
        continue;
      }

      const connection = createSavedConnection(id, validation.value);
      const apiBaseUrl = getConnectionApiBaseUrl(connection);
      if (apiBaseUrls.has(apiBaseUrl)) {
        continue;
      }
      ids.add(id);
      apiBaseUrls.add(apiBaseUrl);
      connections.push(connection);
    }

    const requestedActiveId =
      typeof value.activeConnectionId === "string"
        ? value.activeConnectionId
        : null;
    const activeConnectionId =
      requestedActiveId === null
        ? null
        : connections.some((connection) => connection.id === requestedActiveId)
          ? requestedActiveId
          : (connections[0]?.id ?? null);

    return { activeConnectionId, connections, version: 1 };
  } catch {
    return emptyConnectionStore;
  }
}

export function serializeConnectionStore(store: ConnectionStore): string {
  return JSON.stringify(store);
}

export function selectConnectionInStore(
  store: ConnectionStore,
  connectionId: string | null,
): ConnectionStore {
  if (
    connectionId !== null &&
    !store.connections.some((connection) => connection.id === connectionId)
  ) {
    return store;
  }
  return { ...store, activeConnectionId: connectionId };
}

export function removeConnectionFromStore(
  store: ConnectionStore,
  connectionId: string,
): ConnectionStore {
  const index = store.connections.findIndex(
    (connection) => connection.id === connectionId,
  );
  if (index < 0) {
    return store;
  }

  const connections = store.connections.filter(
    (connection) => connection.id !== connectionId,
  );
  if (store.activeConnectionId !== connectionId) {
    return { ...store, connections };
  }

  return {
    ...store,
    activeConnectionId:
      connections[index]?.id ?? connections[index - 1]?.id ?? null,
    connections,
  };
}

function normalizeHost(
  value: string,
): { host: string; ok: true } | { message: string; ok: false } {
  const isUnbracketedIpv6 = value.includes(":") && !value.startsWith("[");
  const urlHost = isUnbracketedIpv6 ? `[${value}]` : value;

  let parsed: URL;
  try {
    parsed = new URL(`http://${urlHost}`);
  } catch {
    return { message: "Enter a valid hostname or IP address.", ok: false };
  }

  if (parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return {
      message: "Enter the port separately from the host.",
      ok: false,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return { message: "Enter a valid hostname or IP address.", ok: false };
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    return { host, ok: true };
  }

  const hostnameWithoutTrailingDot = host.endsWith(".")
    ? host.slice(0, -1)
    : host;
  if (hostnameWithoutTrailingDot.length > 253) {
    return { message: "Hostname is too long.", ok: false };
  }
  const labels = hostnameWithoutTrailingDot.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return { message: "Enter a valid hostname or IP address.", ok: false };
  }

  return { host: hostnameWithoutTrailingDot, ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
