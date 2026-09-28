import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { PartnersApp } from "./partners/PartnersApp.js";
import { ToastProvider } from "./components/Toast.js";
import "./index.css";

/**
 * One bundle is the ops console at `/console`; built `--mode partners` it
 * is the partner portal at `/` — a servicer's team and their book, on its
 * own hostname, against our own door. Same primitives, different product.
 */
const partners = import.meta.env.MODE === "partners";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A queue changes under people's hands; thirty seconds is long enough
      // to feel instant moving between views and short enough to be honest.
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: true,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={partners ? "/" : "/console"}>
        <ToastProvider>{partners ? <PartnersApp /> : <App />}</ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
