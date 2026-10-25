import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./screens/Activity";
import { Automate } from "./screens/Automate";
import { Connections } from "./screens/Connections";
import { Home } from "./screens/Home";
import { Organise } from "./screens/Organise";
import { Settings } from "./screens/Settings";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: "organise", element: <Organise /> },
      { path: "automate", element: <Automate /> },
      { path: "connections", element: <Connections /> },
      { path: "activity", element: <Activity /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
