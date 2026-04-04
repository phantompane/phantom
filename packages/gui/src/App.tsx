import { useEffect, useState } from "react";
import { hc } from "hono/client";
import type { AppType } from "@phantompane/server";

type StatusPayload = {
  mode: string;
  name: string;
  now: string;
};

const client = hc<AppType>("/");

export function App() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
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

        const payload = (await response.json()) as StatusPayload;

        if (!active) {
          return;
        }

        setStatus(payload);
        setError(null);
      } catch (loadError) {
        if (!active) {
          return;
        }

        setStatus(null);
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
            <dd>{loading ? "loading..." : (status?.name ?? "unavailable")}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{loading ? "loading..." : formatTimestamp(status?.now)}</dd>
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

function formatTimestamp(value?: string) {
  if (!value) {
    return "unavailable";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}
