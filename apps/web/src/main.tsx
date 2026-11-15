import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { usePathname } from "./router.tsx";
import "./styles.css";

const RacesPage = lazy(() => import("./races/RacesPage.tsx"));

/** The page for the address: the race library at `/races`, the planner everywhere else. */
function Root() {
  const pathname = usePathname();
  if (/^\/races\/?$/.test(pathname)) {
    return (
      <Suspense fallback={<div className="h-dvh bg-map" />}>
        <RacesPage />
      </Suspense>
    );
  }
  return <App />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
