import { createBrowserRouter, createMemoryRouter } from "react-router";
import { RoutePending } from "./components/loading";
import { HomeRoute } from "./routes/home";
import { RootRoute } from "./routes/root";

const routes = [
  {
    path: "/",
    Component: RootRoute,
    HydrateFallback: RoutePending,
    children: [
      {
        index: true,
        Component: HomeRoute,
      },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}

export function createTestRouter(initialEntries: string[] = ["/"]) {
  return createMemoryRouter(routes, { initialEntries });
}
