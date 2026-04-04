import { useEffect, useState } from "react";
import { client } from "../lib/rpc.ts";

type HealthState =
  | { status: "loading" }
  | { status: "ready"; message: string; runtime: string }
  | { status: "error"; message: string };

export function HomePage() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    const run = async () => {
      try {
        const response = await client.api.health.$get({
          query: {},
        });

        if (!response.ok) {
          setHealth({
            status: "error",
            message: `Request failed with ${response.status}`,
          });
          return;
        }

        const data = await response.json();
        setHealth({
          status: "ready",
          message: data.message,
          runtime: data.runtime,
        });
      } catch (error) {
        setHealth({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void run();
  }, []);

  return (
    <main className="shell">
      <section className="panel">
        <p className="eyebrow">Phantom Server</p>
        <h1>Vite SPA hosted by Hono</h1>
        <p className="lede">
          React Router is running in declarative mode, and API calls use Hono
          RPC against the same `/api` surface that `phantom serve` exposes.
        </p>
        <dl className="statusGrid">
          <div>
            <dt>Frontend</dt>
            <dd>Vite + React Router</dd>
          </div>
          <div>
            <dt>Backend</dt>
            <dd>Hono</dd>
          </div>
          <div>
            <dt>RPC</dt>
            <dd>Hono RPC (`hc`)</dd>
          </div>
          <div>
            <dt>Health</dt>
            <dd>{renderHealth(health)}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

function renderHealth(health: HealthState) {
  switch (health.status) {
    case "loading":
      return "Loading...";
    case "error":
      return health.message;
    case "ready":
      return `${health.message} (${health.runtime})`;
  }
}
