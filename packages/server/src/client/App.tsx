import { Route, Routes } from "react-router";
import { HomePage } from "./components/HomePage.tsx";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
    </Routes>
  );
}
