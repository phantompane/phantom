import { execFileSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";

const fallbackApiTarget = "http://127.0.0.1:9640";

function getApiTarget(): string {
  if (process.env.PORTLESS === "0") {
    return fallbackApiTarget;
  }

  try {
    const target = execFileSync("portless", ["get", "api.phantom"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return target || fallbackApiTarget;
  } catch {
    return fallbackApiTarget;
  }
}

const apiTarget = getApiTarget();
const devServerHost = process.env.HOST;
const devServerPort = Number.parseInt(process.env.PORT ?? "3000", 10);

export default defineConfig({
  server: {
    host: devServerHost,
    port: Number.isFinite(devServerPort) ? devServerPort : 3000,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
  plugins: [tailwindcss(), viteReact()],
});
