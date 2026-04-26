import { createRouter } from "@tanstack/react-router";
import { RoutePending } from "./components/loading";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    defaultPendingComponent: RoutePending,
    defaultPendingMinMs: 350,
    defaultPendingMs: 300,
    routeTree,
    scrollRestoration: true,
  });
}
