import { useEffect, useState } from "react";
import { hc } from "hono/client";
import type { AppType } from "@phantompane/server";

const client = hc<AppType>("/");

export function App() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadStatus() {
      try {
        const response = await client.api.rpc.status.$get();

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        await response.json();

        if (!active) {
          return;
        }

        setConnected(true);
        setError(null);
      } catch (loadError) {
        if (!active) {
          return;
        }

        setConnected(false);
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadStatus();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="panel">
        <p className="eyebrow">Experimental</p>
        <h1>phantom serve</h1>
        <p className="lead">
          Bundled GUI and Hono RPC backend running from a single CLI command.
        </p>
        <dl className="status-grid">
          <div>
            <dt>Frontend</dt>
            <dd>Vite + React</dd>
          </div>
          <div>
            <dt>Backend</dt>
            <dd>Hono RPC</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>{loading ? "loading..." : connected ? "connected" : "unavailable"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{loading ? "loading..." : connected ? "ready" : "offline"}</dd>
          </div>
        </dl>
        {error ? (
          <p className="message error">{error}</p>
        ) : (
          <p className="message success">
            {loading ? "Connecting to /api/rpc/status..." : "RPC connected"}
          </p>
        )}
      </section>
    </main>
  );
}
