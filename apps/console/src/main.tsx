import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { ToastProvider } from "./components/Toast.js";
import "./index.css";

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
      <BrowserRouter basename="/console">
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
