import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  configureApiBaseUrl,
  configuredApiBaseUrl,
  defaultApiBaseUrl,
} from "./api/client";
import {
  connectionStorageKey,
  createSavedConnection,
  getConnectionApiBaseUrl,
  getConnectionDisplayName,
  getConnectionEndpointLabel,
  parseConnectionStore,
  removeConnectionFromStore,
  selectConnectionInStore,
  serializeConnectionStore,
  validateConnectionInput,
  type ConnectionFieldErrors,
  type ConnectionInput,
  type ConnectionStore,
  type SavedConnection,
} from "./connections";

const implicitConnectionId = "__phantom_build_time_connection__";

export interface ActiveConnection {
  apiBaseUrl: string;
  connectionKey: string;
  displayName: string;
  endpointLabel: string;
  id: string;
  isImplicit: boolean;
  savedConnection: SavedConnection | null;
}

export type SaveConnectionResult =
  | {
      errors: ConnectionFieldErrors;
      ok: false;
    }
  | {
      connection: SavedConnection;
      ok: true;
    };

interface ConnectionContextValue {
  activeConnection: ActiveConnection | null;
  addConnection: (input: ConnectionInput) => SaveConnectionResult;
  availableConnections: ActiveConnection[];
  removeConnection: (connectionId: string) => void;
  savedConnections: SavedConnection[];
  selectConnection: (connectionId: string) => void;
  updateConnection: (
    connectionId: string,
    input: ConnectionInput,
  ) => SaveConnectionResult;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) {
  const implicitConnection = useMemo(getImplicitConnection, []);
  const [store, setStore] = useState<ConnectionStore>(() => {
    const initialStore = readConnectionStore();
    configureApiBaseUrl(
      resolveActiveConnection(initialStore, implicitConnection)?.apiBaseUrl ??
        defaultApiBaseUrl,
    );
    return initialStore;
  });
  const storeRef = useRef(store);
  storeRef.current = store;

  const commitStore = useCallback(
    (nextStore: ConnectionStore, persist = true) => {
      const previousConnection = resolveActiveConnection(
        storeRef.current,
        implicitConnection,
      );
      const nextConnection = resolveActiveConnection(
        nextStore,
        implicitConnection,
      );
      const activeConnectionChanged =
        previousConnection?.id !== nextConnection?.id ||
        previousConnection?.apiBaseUrl !== nextConnection?.apiBaseUrl;

      if (activeConnectionChanged) {
        configureApiBaseUrl(nextConnection?.apiBaseUrl ?? defaultApiBaseUrl);
        queryClient.clear();
      }
      if (persist) {
        writeConnectionStore(nextStore);
      }
      storeRef.current = nextStore;
      setStore(nextStore);
    },
    [implicitConnection, queryClient],
  );

  useEffect(() => {
    writeConnectionStore(storeRef.current);

    function handleStorage(event: StorageEvent) {
      if (event.key !== connectionStorageKey) {
        return;
      }
      commitStore(parseConnectionStore(event.newValue), false);
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [commitStore]);

  const addConnection = useCallback(
    (input: ConnectionInput): SaveConnectionResult => {
      const validation = validateConnectionInput(input);
      if (!validation.ok) {
        return validation;
      }
      const apiBaseUrl = getConnectionApiBaseUrl(validation.value);
      if (
        storeRef.current.connections.some(
          (connection) => getConnectionApiBaseUrl(connection) === apiBaseUrl,
        )
      ) {
        return {
          errors: { form: "This endpoint is already saved." },
          ok: false,
        };
      }

      const connection = createSavedConnection(
        createConnectionId(),
        validation.value,
      );
      commitStore({
        ...storeRef.current,
        activeConnectionId: connection.id,
        connections: [...storeRef.current.connections, connection],
      });
      return { connection, ok: true };
    },
    [commitStore],
  );

  const updateConnection = useCallback(
    (connectionId: string, input: ConnectionInput): SaveConnectionResult => {
      const validation = validateConnectionInput(input);
      if (!validation.ok) {
        return validation;
      }
      const existingConnection = storeRef.current.connections.find(
        (connection) => connection.id === connectionId,
      );
      if (!existingConnection) {
        return {
          errors: { form: "This saved connection no longer exists." },
          ok: false,
        };
      }

      const apiBaseUrl = getConnectionApiBaseUrl(validation.value);
      if (
        storeRef.current.connections.some(
          (connection) =>
            connection.id !== connectionId &&
            getConnectionApiBaseUrl(connection) === apiBaseUrl,
        )
      ) {
        return {
          errors: { form: "This endpoint is already saved." },
          ok: false,
        };
      }

      const connection = createSavedConnection(connectionId, validation.value);
      commitStore({
        ...storeRef.current,
        connections: storeRef.current.connections.map((candidate) =>
          candidate.id === connectionId ? connection : candidate,
        ),
      });
      return { connection, ok: true };
    },
    [commitStore],
  );

  const removeConnection = useCallback(
    (connectionId: string) => {
      commitStore(removeConnectionFromStore(storeRef.current, connectionId));
    },
    [commitStore],
  );

  const selectConnection = useCallback(
    (connectionId: string) => {
      if (connectionId === implicitConnectionId && implicitConnection) {
        commitStore(selectConnectionInStore(storeRef.current, null));
        return;
      }
      commitStore(selectConnectionInStore(storeRef.current, connectionId));
    },
    [commitStore, implicitConnection],
  );

  const activeConnection = resolveActiveConnection(store, implicitConnection);
  const availableConnections = useMemo(
    () => [
      ...(implicitConnection ? [implicitConnection] : []),
      ...store.connections.map(resolveSavedConnection),
    ],
    [implicitConnection, store.connections],
  );
  const contextValue = useMemo<ConnectionContextValue>(
    () => ({
      activeConnection,
      addConnection,
      availableConnections,
      removeConnection,
      savedConnections: store.connections,
      selectConnection,
      updateConnection,
    }),
    [
      activeConnection,
      addConnection,
      availableConnections,
      removeConnection,
      selectConnection,
      store.connections,
      updateConnection,
    ],
  );

  return (
    <ConnectionContext.Provider value={contextValue}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnections(): ConnectionContextValue {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error("useConnections must be used within ConnectionProvider.");
  }
  return context;
}

export function useActiveConnection(): ActiveConnection {
  const { activeConnection } = useConnections();
  if (!activeConnection) {
    throw new Error("An active Phantom connection is required.");
  }
  return activeConnection;
}

function resolveActiveConnection(
  store: ConnectionStore,
  implicitConnection: ActiveConnection | null,
): ActiveConnection | null {
  if (store.activeConnectionId) {
    const connection = store.connections.find(
      (candidate) => candidate.id === store.activeConnectionId,
    );
    if (connection) {
      return resolveSavedConnection(connection);
    }
  }
  if (implicitConnection) {
    return implicitConnection;
  }
  const firstConnection = store.connections[0];
  return firstConnection ? resolveSavedConnection(firstConnection) : null;
}

function resolveSavedConnection(connection: SavedConnection): ActiveConnection {
  const apiBaseUrl = getConnectionApiBaseUrl(connection);
  return {
    apiBaseUrl,
    connectionKey: `${connection.id}:${apiBaseUrl}`,
    displayName: getConnectionDisplayName(connection),
    endpointLabel: getConnectionEndpointLabel(connection),
    id: connection.id,
    isImplicit: false,
    savedConnection: connection,
  };
}

function getImplicitConnection(): ActiveConnection | null {
  const apiBaseUrl =
    configuredApiBaseUrl ?? (import.meta.env.DEV ? "/api" : null);
  if (!apiBaseUrl) {
    return null;
  }
  const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, "") || "/api";
  let endpointLabel = normalizedApiBaseUrl;
  if (normalizedApiBaseUrl.startsWith("http")) {
    try {
      endpointLabel = new URL(normalizedApiBaseUrl).origin;
    } catch {
      // Keep the configured value as its label.
    }
  }
  return {
    apiBaseUrl: normalizedApiBaseUrl,
    connectionKey: `${implicitConnectionId}:${normalizedApiBaseUrl}`,
    displayName: configuredApiBaseUrl
      ? "Configured connection"
      : "Local development",
    endpointLabel,
    id: implicitConnectionId,
    isImplicit: true,
    savedConnection: null,
  };
}

function readConnectionStore(): ConnectionStore {
  try {
    return parseConnectionStore(
      window.localStorage.getItem(connectionStorageKey),
    );
  } catch {
    return parseConnectionStore(null);
  }
}

function writeConnectionStore(store: ConnectionStore): void {
  try {
    window.localStorage.setItem(
      connectionStorageKey,
      serializeConnectionStore(store),
    );
  } catch {
    // Storage can be unavailable in private browsing. Keep in-memory state usable.
  }
}

function createConnectionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `connection-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
