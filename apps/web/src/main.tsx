import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { AuthProvider } from "./lib/auth.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The assessment changes after every connector call, and a stale panel
      // showing satisfied work as outstanding is the one thing that makes the
      // flow feel broken.
      staleTime: 0,
      retry: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
