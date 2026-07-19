import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { ConnectionProvider } from "./connection-context";
import { registerServiceWorker } from "./pwa";
import { createAppRouter } from "./router";

const queryClient = new QueryClient();
const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider queryClient={queryClient}>
        <RouterProvider router={createAppRouter()} />
      </ConnectionProvider>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
