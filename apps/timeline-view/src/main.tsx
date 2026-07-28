import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TimelineApp } from "./timeline.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Timeline root element is missing");
createRoot(root).render(<StrictMode><TimelineApp /></StrictMode>);
