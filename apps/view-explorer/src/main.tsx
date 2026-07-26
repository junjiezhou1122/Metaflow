import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ViewExplorer } from "./explorer.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("View Explorer root element is missing");
createRoot(root).render(<StrictMode><ViewExplorer /></StrictMode>);
