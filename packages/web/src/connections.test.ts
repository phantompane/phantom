import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import {
  createSavedConnection,
  getConnectionApiBaseUrl,
  getConnectionDisplayName,
  parseConnectionStore,
  removeConnectionFromStore,
  selectConnectionInStore,
  serializeConnectionStore,
  validateConnectionInput,
  type ConnectionStore,
} from "./connections";

describe("validateConnectionInput", () => {
  it("normalizes a domain connection with an optional name and port", () => {
    const result = validateConnectionInput({
      host: "  Phantom.EXAMPLE.com. ",
      name: " Home Mac ",
      port: " 9640 ",
      protocol: "https",
    });

    deepStrictEqual(result, {
      ok: true,
      value: {
        host: "phantom.example.com",
        name: "Home Mac",
        port: 9640,
        protocol: "https",
      },
    });
  });

  it("accepts IPv4 and bracketed or unbracketed IPv6 hosts", () => {
    for (const [input, expected] of [
      ["192.168.1.20", "192.168.1.20"],
      ["[::1]", "[::1]"],
      ["::1", "[::1]"],
    ]) {
      const result = validateConnectionInput({
        host: input,
        port: "",
        protocol: "http",
      });
      strictEqual(result.ok, true);
      if (result.ok) {
        strictEqual(result.value.host, expected);
        strictEqual(result.value.port, null);
      }
    }
  });

  it("rejects schemes, paths, embedded ports, and credentials", () => {
    for (const host of [
      "https://example.com",
      "example.com/api",
      "example.com:9640",
      "me@example.com",
    ]) {
      const result = validateConnectionInput({
        host,
        protocol: "http",
      });
      strictEqual(result.ok, false, host);
      if (!result.ok) {
        strictEqual(typeof result.errors.host, "string");
      }
    }
  });

  it("rejects invalid protocols, hostnames, and ports", () => {
    for (const input of [
      { host: "bad host", port: "9640", protocol: "http" },
      { host: "-bad.example", port: "9640", protocol: "http" },
      { host: "example.com", port: "0", protocol: "http" },
      { host: "example.com", port: "65536", protocol: "http" },
      { host: "example.com", port: "9.5", protocol: "http" },
      { host: "example.com", port: "9640", protocol: "ftp" },
    ]) {
      strictEqual(validateConnectionInput(input).ok, false);
    }
  });
});

describe("connection URLs", () => {
  it("builds API base URLs and display names", () => {
    const connection = createSavedConnection("home", {
      host: "phantom.example.com",
      name: null,
      port: 443,
      protocol: "https",
    });

    strictEqual(
      getConnectionApiBaseUrl(connection),
      "https://phantom.example.com/api",
    );
    strictEqual(
      getConnectionDisplayName(connection),
      "phantom.example.com:443",
    );
  });
});

describe("connection storage", () => {
  const store: ConnectionStore = {
    activeConnectionId: "home",
    connections: [
      createSavedConnection("home", {
        host: "192.168.1.20",
        name: "Home",
        port: 9640,
        protocol: "http",
      }),
      createSavedConnection("work", {
        host: "phantom.work.example",
        name: "Work",
        port: null,
        protocol: "https",
      }),
    ],
    version: 1,
  };

  it("round trips valid stores", () => {
    deepStrictEqual(
      parseConnectionStore(serializeConnectionStore(store)),
      store,
    );
  });

  it("falls back safely for corrupt or unsupported stores", () => {
    deepStrictEqual(parseConnectionStore("not json"), {
      activeConnectionId: null,
      connections: [],
      version: 1,
    });
    deepStrictEqual(
      parseConnectionStore(JSON.stringify({ connections: [], version: 2 })),
      {
        activeConnectionId: null,
        connections: [],
        version: 1,
      },
    );
  });

  it("drops malformed and duplicate endpoints and repairs invalid active IDs", () => {
    const parsed = parseConnectionStore(
      JSON.stringify({
        activeConnectionId: "missing",
        connections: [
          store.connections[0],
          { ...store.connections[0], id: "duplicate" },
          { host: "bad host", id: "bad", protocol: "http" },
          store.connections[1],
        ],
        version: 1,
      }),
    );

    deepStrictEqual(parsed.connections, store.connections);
    strictEqual(parsed.activeConnectionId, "home");
  });

  it("selects connections and chooses a neighbor when deleting the active one", () => {
    strictEqual(
      selectConnectionInStore(store, "work").activeConnectionId,
      "work",
    );
    deepStrictEqual(selectConnectionInStore(store, "missing"), store);

    const withoutHome = removeConnectionFromStore(store, "home");
    strictEqual(withoutHome.activeConnectionId, "work");
    deepStrictEqual(withoutHome.connections, [store.connections[1]]);

    const empty = removeConnectionFromStore(withoutHome, "work");
    strictEqual(empty.activeConnectionId, null);
    deepStrictEqual(empty.connections, []);
  });
});
