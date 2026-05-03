import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";

const apiTarget = process.env.PHANTOM_API_DEV_ORIGIN ?? "http://127.0.0.1:9640";

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  plugins: [tailwindcss(), viteReact()],
});
