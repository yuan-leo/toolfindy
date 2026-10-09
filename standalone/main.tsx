import React from "react";
import { createRoot } from "react-dom/client";
import InventoryApp from "@/app/InventoryApp";
import "@/app/globals.css";

const root = document.getElementById("root");

if (!root) throw new Error("Tool Findy could not find its application root.");

createRoot(root).render(
  <React.StrictMode>
    <InventoryApp />
  </React.StrictMode>,
);
