/**
 * The one sign-in. One field — a work e-mail — and the domain decides
 * which door it goes to: ours to the staff door (the servicing app's,
 * proxied), every other to the servicer door (our own API). A rule, not a
 * lookup, so typing an address tells nobody whether it is on a team; and a
 * link on each door leads to the other for the odd address the rule gets
 * wrong.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Field, Input, Notice } from "../components/ui.js";
import { useAuth } from "../lib/auth.js";
import { portal } from "../partners/api.js";
import { PortalWordmark } from "../partners/Shell.js";
import { ServicerSignInPage } from "../partners/pages/SignInPage.js";
import { SignInPage } from "./SignInPage.js";

/** What the server says when it cannot be asked: the domains that are ours today. */
const INTERNAL_DOMAINS_FALLBACK = ["supermortgage.com", "trywalt.ai"];

type Door = { kind: "staff" | "servicer"; email: string };

export function EntryPage() {
  const { endedBecause } = useAuth();
  const [email, setEmail] = useState("");
  const [door, setDoor] = useState<Door | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const domains = useQuery({
    queryKey: ["entry-door"],
    queryFn: () => portal<{ internalDomains: string[] }>("/auth/door"),
    staleTime: Infinity,
    retry: 1,
  });

  useEffect(() => {
    if (!door) first.current?.focus();
  }, [door]);

  const choose = (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    const domain = address.split("@")[1] ?? "";
    const internal = (domains.data?.internalDomains ?? INTERNAL_DOMAINS_FALLBACK).includes(domain);
    setDoor({ kind: internal ? "staff" : "servicer", email: address });
  };

  if (door?.kind === "staff") {
    return (
      <SignInPage
        initialEmail={door.email}
        onBack={() => setDoor(null)}
        onServicer={() => setDoor({ kind: "servicer", email: door.email })}
      />
    );
  }
  if (door?.kind === "servicer") {
    return (
      <ServicerSignInPage
        initialEmail={door.email}
        onBack={() => setDoor(null)}
        onStaff={() => setDoor({ kind: "staff", email: door.email })}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-5 py-12">
        {/* The bare mark: this page is a servicer's team's as much as ours. */}
        <div className="mb-8">
          <PortalWordmark />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Sign in</h1>
        <p className="mt-1.5 text-base text-fg-2">
          Supermortgage servicing. Your e-mail decides where you land.
        </p>

        {endedBecause === "expired" ? (
          <Notice tone="neutral" className="mt-5">
            Your session ended after thirty minutes idle. Sign in again to pick up where you were.
          </Notice>
        ) : null}

        <div className="mt-6 rounded-xl border border-line-2 bg-surface p-5 shadow-card sm:p-6">
          <form onSubmit={choose} className="space-y-4">
            <Field label="Work e-mail" htmlFor="email">
              <Input
                ref={first}
                id="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                placeholder="you@yourcompany.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" variant="primary" className="w-full">
              Continue
            </Button>
          </form>
        </div>

        <p className="mt-6 text-sm text-fg-3">
          Two factors, always: a code to your e-mail and your password. Every action is recorded
          with your name.
        </p>
      </div>
    </div>
  );
}
