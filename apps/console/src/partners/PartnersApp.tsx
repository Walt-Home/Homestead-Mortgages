/**
 * The partner portal: a servicer's team and their book.
 *
 * Three doors and two pages. `/accept` takes an invitation whatever the
 * session; everything else is the sign-in until there is one, then the
 * book and the team inside a frame of their own. Same primitives as the
 * ops console, none of its navigation: nothing here reaches the servicing
 * app's console API, only our own door.
 */

import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loading } from "../components/Loading.js";
import { PortalAuthProvider, usePortalAuth } from "./auth.js";
import { PortalShell } from "./Shell.js";
import { AcceptPage } from "./pages/AcceptPage.js";
import { BookPage } from "./pages/BookPage.js";
import { SignInPage } from "./pages/SignInPage.js";
import { TeamPage } from "./pages/TeamPage.js";

function Routed() {
  const { status, me } = usePortalAuth();
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = me ? `${me.servicer.displayName} · Supermortgage` : "Supermortgage";
  }, [me]);
  if (pathname === "/accept") return <AcceptPage />;
  if (status === "loading") return <Loading what="Opening your book" />;
  if (status === "signed-out") return <SignInPage />;
  return (
    <PortalShell>
      <Routes>
        <Route index element={<BookPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PortalShell>
  );
}

export function PartnersApp() {
  return (
    <PortalAuthProvider>
      <Routed />
    </PortalAuthProvider>
  );
}
