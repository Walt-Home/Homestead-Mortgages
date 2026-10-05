/**
 * The servicing hostname, served by this process.
 *
 * `servicing.supermortgage.com` is one backend behind Identity-Aware Proxy,
 * and that backend is this container. On that Host — and only on it — the
 * API is not the borrower app: it serves the ops console built from
 * apps/console under `/console`, and it forwards the console's calls to
 * Doug's runtime, whose door is `SERVICING_API_URL`, the same URL the
 * `servicing` connector reads. `/console/api/*` is his `/ops/api/*` and
 * `/console/documents/*` is his `/api/documents/*`, and those two are all
 * of his that this host serves: his own console at `/ops`, his API at
 * `/api` and his sign-in links were forwarded "for comparison" until 5
 * October 2026 and are closed. Everything else on that Host is a 404, so
 * nothing of the borrower app is reachable through the servicing name.
 *
 * Why a proxy rather than a second backend on the load balancer: IAP keys
 * its session cookie per backend, and a console served by one backend
 * calling an API on another would sign in twice and fail the second time
 * silently, from a fetch. One backend, one cookie, one sign-in. His session
 * cookie (`sm_staff`, Secure, SameSite=Strict, Path=/) is set by his
 * response and passed through unchanged, so it lands on the branded host
 * and rides every later call.
 *
 * Mounted first, above the body parser and the session, so a request on the
 * servicing Host is forwarded whole — his server parses its own bodies — and
 * never mints a cookie of ours. On any other Host this is a no-op.
 *
 * **A sign-in code never crosses this proxy on a real deployment.** The
 * servicing app's vendors are stand-ins, so it runs as non-production even
 * in production, and a non-production servicing app with a stand-in mailer
 * hands the six-digit code back in the answer for the page to show. That
 * was harmless behind Identity-Aware Proxy and is not since the host went
 * public for the servicers' portal: anybody who knew a staff address was
 * shown that person's code, and the console's two factors were one. So
 * where OUR mailer is real (`codes` below), every answer to a forwarded
 * write is read before it is passed on and any echoed code is taken out of
 * it, at any depth, on both forwarded paths; and the staff door's code is
 * mailed by us instead — to the address that asked, and only when that
 * address is on one of our own domains, so the door cannot be made to mail
 * a stranger. The vendored tree is not touched: the servicing app has no
 * public invoker, this proxy is the only way to it, and the seam is ours.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type Router } from "express";
import { config } from "./config.js";
import { consoleBillingRouter } from "./routes/console-billing.js";
import { consoleTapeRouter } from "./routes/console-tape.js";
import { connectors } from "./services/connectors.js";
import {
  IDENTITY_HEADER,
  identityTokenFor,
  type IdentityTokenProvider,
} from "./services/google-identity.js";

/** How a sign-in code reaches a person where our mailer is real: by mail, to our own domains only. */
export interface SignInCodeMail {
  /** Whether an address is on one of our own domains: the only ones a staff code is mailed to. */
  internal(email: string): boolean;
  /** Mail the code. False when the mailer would not, and then nobody is told the code. */
  send(to: string, code: string): Promise<boolean>;
  /** Mail somebody the news that an admin invited them, and where to sign in. */
  invite(
    to: string,
    input: { readonly name: string | null; readonly signInUrl: string },
  ): Promise<boolean>;
}

export interface ConsoleHostOptions {
  /** The Host this router answers. */
  readonly host: string;
  /** His runtime's origin, e.g. https://…run.app — no trailing slash. */
  readonly upstream: string;
  /** Where the console bundle is; unset when it was not built. */
  readonly dist?: string;
  /** Test seam: the fetch to forward with. */
  readonly fetchImpl?: typeof fetch;
  /**
   * A Google identity token for his URL, when his service is behind Cloud
   * Run's own IAM gate — sent on the header Cloud Run reserves for it and
   * strips before his server looks. Null sends nothing.
   */
  readonly identityToken?: IdentityTokenProvider;
  /**
   * The prefixes on this host our API answers itself: the tape desk, at
   * `/console/hm/tape`, and billing, at `/console/hm/billing`, each gated
   * by the servicing app's own session. Unset in a test that is only about
   * the forwarding.
   */
  readonly tape?: Router;
  readonly billing?: Router;
  /**
   * Set where our mailer is real. Then no answer carries an echoed code
   * across, and the staff door's code is mailed through this. Unset — in
   * development and in a test of the forwarding — answers cross as they
   * are, which is what lets a developer sign in with no mailbox.
   */
  readonly codes?: SignInCodeMail;
}

/** The field the servicing app echoes a code in, on every door that mints one. */
const ECHOED_CODE = "fake_code";
/** The staff door's code request, as his server names it, however it was reached. */
const STAFF_CODE_PATH = "/ops/api/auth/code";
/** An admin inviting somebody onto the staff, as his server names it. */
const STAFF_INVITE_PATH = "/ops/api/staff/invite";
/** A code request is an address and nothing else; an invitation is a few fields more. */
const MAX_CODE_REQUEST_BYTES = 16 * 1024;
const MAX_INVITE_REQUEST_BYTES = 64 * 1024;

/** The same value with every echoed code removed, at any depth, and whether one was there. */
export function withoutEchoedCodes(value: unknown): { value: unknown; found: boolean } {
  if (Array.isArray(value)) {
    let found = false;
    const out = value.map((v) => {
      const inner = withoutEchoedCodes(v);
      found ||= inner.found;
      return inner.value;
    });
    return { value: out, found };
  }
  if (value !== null && typeof value === "object") {
    let found = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === ECHOED_CODE) {
        found = true;
        continue;
      }
      const inner = withoutEchoedCodes(v);
      found ||= inner.found;
      out[key] = inner.value;
    }
    return { value: out, found };
  }
  return { value, found: false };
}

/** A small request body, whole; null when it is larger than a code request could be. */
async function readSmall(req: Request, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += piece.length;
    if (size > limit) return null;
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

/** The address a request names, lowercased, and the person's name when it gives one. */
function addressIn(body: Buffer): { email: string | null; name: string | null } {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { email?: unknown; legal_name?: unknown };
    return {
      email:
        typeof parsed.email === "string" && parsed.email.includes("@")
          ? parsed.email.trim().toLowerCase()
          : null,
      name:
        typeof parsed.legal_name === "string" && parsed.legal_name.trim() !== ""
          ? parsed.legal_name.trim()
          : null,
    };
  } catch {
    return { email: null, name: null };
  }
}

/** The request headers that cross to his server. Nothing else does. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "if-none-match",
  "range",
  "x-actor-id",
  "x-actor-role",
  // The role the console acts as, on every call; without it his API runs
  // each act as the least role the session holds and refuses the rest.
  "x-staff-role",
] as const;

/** The response headers that cross back. `set-cookie` is handled apart. */
const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "location",
  "retry-after",
  // The role his API actually ran under, which the console shows when it
  // differs from the one asked for.
  "x-acted-as",
] as const;

export function consoleHostRouter(opts: ConsoleHostOptions): Router {
  const router = express.Router();
  const upstream = opts.upstream.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  const forward =
    (rewrite: (path: string) => string) =>
    async (req: Request, res: Response): Promise<void> => {
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const identity = opts.identityToken ? await opts.identityToken() : null;
      if (identity) headers.set(IDENTITY_HEADER, `Bearer ${identity}`);
      headers.set("x-forwarded-for", req.ip ?? "");
      headers.set("x-forwarded-proto", req.protocol);
      // The name the person actually used, so a link the servicing app
      // builds from it comes back to the same door.
      headers.set("x-forwarded-host", req.hostname || opts.host);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const target = rewrite(req.url);
      // Only a write can mint a code, so only a write's answer is read first.
      const guarded = opts.codes !== undefined && hasBody;
      const upstreamPath = target.split("?")[0];
      const staffCode = guarded && req.method === "POST" && upstreamPath === STAFF_CODE_PATH;
      // An invitation is the servicing app's to make and ours to tell the
      // person about: its mailer is a stand-in, so without this the invitee
      // hears nothing and has to be told by hand to go and sign in.
      const staffInvite = guarded && req.method === "POST" && upstreamPath === STAFF_INVITE_PATH;
      // Both requests are read whole, for the address the mail goes to.
      let asked: string | null = null;
      let askedName: string | null = null;
      let body: ReadableStream | Buffer | undefined;
      if (staffCode || staffInvite) {
        const whole = await readSmall(
          req,
          staffCode ? MAX_CODE_REQUEST_BYTES : MAX_INVITE_REQUEST_BYTES,
        );
        if (whole === null) {
          res.status(413).json({
            error: { message: "That is too much to be an e-mail address.", code: "TOO_LARGE" },
          });
          return;
        }
        ({ email: asked, name: askedName } = addressIn(whole));
        body = whole;
      } else if (hasBody) {
        body = Readable.toWeb(req) as ReadableStream;
      }
      let answer: globalThis.Response;
      try {
        answer = await doFetch(upstream + target, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
          // A streamed request body needs this; the DOM lib does not know it.
          ...({ duplex: "half" } as object),
        });
      } catch (err) {
        res.status(502).json({
          error: { message: "The servicing platform could not be reached.", code: "UPSTREAM" },
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      res.status(answer.status);
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = answer.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      for (const cookie of answer.headers.getSetCookie()) res.append("Set-Cookie", cookie);
      if (!answer.body || req.method === "HEAD" || answer.status === 204 || answer.status === 304) {
        res.end();
        return;
      }
      if (guarded && (answer.headers.get("content-type") ?? "").includes("json")) {
        const text = await answer.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          res.end(text);
          return;
        }
        const cleaned = withoutEchoedCodes(parsed);
        const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
        const invited = staffInvite && answer.ok && isObject;
        if (!cleaned.found && !invited) {
          res.end(text);
          return;
        }
        // The body is no longer his, so neither is its validator.
        res.removeHeader("etag");
        if (invited) {
          // Told to the person by us, and the admin is told whether it went:
          // mailed, not mailed, or an address that is not on our domains and
          // so is never written to from here.
          let mailed: "sent" | "not_sent" | "not_ours" = "not_ours";
          if (asked !== null && opts.codes!.internal(asked)) {
            const signInUrl = `https://${req.hostname || opts.host}/console/`;
            mailed = (await opts.codes!.invite(asked, { name: askedName, signInUrl }))
              ? "sent"
              : "not_sent";
          }
          (cleaned.value as Record<string, unknown>).invitation_mail = mailed;
        }
        const top = parsed as Record<string, unknown>;
        const code = isObject ? top[ECHOED_CODE] : undefined;
        if (staffCode && typeof code === "string") {
          // Mailed to the address that asked, when it is one of ours; a
          // stranger's address is answered the same and mailed nothing.
          if (asked !== null && opts.codes!.internal(asked)) {
            const sent = await opts.codes!.send(asked, code);
            if (!sent) {
              res.status(502).json({
                error: {
                  message:
                    "The sign-in code could not be mailed. Try again in ten minutes, or ask an admin.",
                  code: "CODE_NOT_MAILED",
                },
              });
              return;
            }
          }
          (cleaned.value as Record<string, unknown>).delivery = "email";
        }
        res.json(cleaned.value);
        return;
      }
      await pipeline(Readable.fromWeb(answer.body as never), res);
    };

  // The front door of the branded host is the console. Exactly `/console`,
  // with no slash: Express's loose matching would send `/console/` here
  // too, ahead of the bundle, and redirect it to itself forever.
  router.get("/", (_req, res) => res.redirect(302, "/console/"));
  router.get(/^\/console$/, (_req, res) => res.redirect(302, "/console/"));

  // Ours, before anything forwarded: the tape desk and billing answer here.
  if (opts.tape) router.use("/console/hm/tape", opts.tape);
  if (opts.billing) router.use("/console/hm/billing", opts.billing);

  // The console's calls, to the servicing app's console API and its document reads.
  router.use(
    "/console/api",
    forward((path) => `/ops/api${path}`),
  );
  router.use(
    "/console/documents",
    forward((path) => `/api/documents${path}`),
  );

  // Ours, and never forwarded: the partner portal's door. A servicer's
  // team signs in on this host too — the console's one sign-in page sends
  // them here — so this one prefix leaves this router for the chain below,
  // where the body parser, the session and the door are. Everything else
  // under `/api` on this host is the servicing app's, as before.
  router.use("/api/servicer", (_req, _res, next) => next("router"));

  // The servicing app's own console, its API and its sign-in links are not
  // served on this host. They were forwarded as they are "for comparison"
  // while the host was behind Identity-Aware Proxy; on a public host that
  // was the whole of his surface offered to anybody, and our console uses
  // none of it (closed 5 October 2026, Joe). What crosses is what is named
  // above: `/console/api` and `/console/documents`. A bookmark to his
  // console lands on ours; everything else of his is the 404 below.
  router.get(/^\/ops\/?$/, (_req, res) => res.redirect(302, "/console/"));

  // The bundle: immutable hashed assets, an entrypoint that is never cached,
  // and a history fallback for the console's own routes.
  if (opts.dist) {
    const dist = opts.dist;
    router.use(
      "/console",
      express.static(dist, {
        index: false,
        setHeaders: (res, path) => {
          res.setHeader(
            "Cache-Control",
            path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
          );
        },
      }),
    );
    router.get(/^\/console\/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(join(dist, "index.html"));
    });
  } else {
    router.get(/^\/console\/.*/, (_req, res) => {
      res.status(503).json({
        error: { message: "The console is not built on this deployment.", code: "NOT_BUILT" },
      });
    });
  }

  // Nothing of the borrower app answers on the servicing name.
  router.use((_req, res) => {
    res.status(404).json({ error: { message: "No such page.", code: "NOT_FOUND" } });
  });

  return router;
}

/**
 * The staff door's code, as we mail it.
 *
 * The servicing app answers a code request the same whether or not the
 * address is a staff member's, and mints a code either way, so this is
 * mailed to any address of ours that asks — including one nobody has
 * invited, whose code can never be accepted. The message has to say so,
 * because the page cannot: the first person to hit it was the owner,
 * signing in with the address he works under rather than the one the
 * deploy had made admin, holding a code that "didn't match" (5 October
 * 2026).
 */
export function staffSignInCodeMessage(input: { readonly to: string; readonly code: string }) {
  return {
    to: input.to,
    subject: `Your Supermortgage console sign-in code: ${input.code}`,
    text: [
      `Your sign-in code for the Supermortgage console is ${input.code}.`,
      "",
      "It is good for ten minutes and one sign-in, and only for an address an admin has invited to the console. If this address has not been invited, the code will not be accepted: sign in with the address that was invited, or ask an admin to invite this one from Staff & roles.",
      "",
      "If you did not ask for it, ignore this message; nobody can sign in with the code alone.",
      "",
      "Supermortgage",
    ].join("\n"),
  };
}

/**
 * The news that an admin invited somebody to the console, as we mail it.
 * The servicing app makes the account and tells nobody — its mailer is a
 * stand-in — so the first invitation made on production reached no inbox
 * (5 October 2026, Joe inviting his own second address).
 */
export function staffInvitationMessage(input: {
  readonly to: string;
  readonly name: string | null;
  readonly signInUrl: string;
}) {
  return {
    to: input.to,
    subject: "You have been invited to the Supermortgage console",
    text: [
      `${input.name ? `${input.name}, you` : "You"} have been invited to the Supermortgage console as ${input.to}.`,
      "",
      `To sign in, go to ${input.signInUrl} and enter this address. A six-digit code is mailed to you each time you sign in, and the first time you choose a password.`,
      "",
      "If you were not expecting this, ignore it; nothing happens until you sign in.",
      "",
      "Supermortgage",
    ].join("\n"),
  };
}

/**
 * How a staff sign-in code reaches a person on this deployment: mailed by
 * us where our mailer is real, shown on the page where it is a stand-in.
 * Health reports it, and the production deploy fails on the second.
 */
export function staffSignInCodes(): "mailed" | "shown on the page" {
  return connectors().mail.capabilities.mode === "fixture" ? "shown on the page" : "mailed";
}

/** The mailing of codes where our mailer is real; undefined where it is a stand-in. */
export function signInCodeMail(): SignInCodeMail | undefined {
  if (staffSignInCodes() !== "mailed") return undefined;
  return {
    internal: (email) =>
      config.internalEmailDomains.includes(email.slice(email.lastIndexOf("@") + 1).toLowerCase()),
    send: async (to, code) => {
      try {
        const outcome = await connectors().mail.send(staffSignInCodeMessage({ to, code }));
        return outcome.status === "sent";
      } catch {
        return false;
      }
    },
    invite: async (to, { name, signInUrl }) => {
      try {
        const outcome = await connectors().mail.send(
          staffInvitationMessage({ to, name, signInUrl }),
        );
        return outcome.status === "sent";
      } catch {
        return false;
      }
    },
  };
}

/**
 * Mount the servicing-host router when there is a servicing hostname to
 * answer. Returns what was mounted, for the start-up log.
 */
export function consoleHost(app: Express): "not-configured" | "proxy-only" | "console" {
  const hosts = new Set(config.servicing.publicHosts);
  const host = config.servicing.publicHost;
  const upstream = config.servicing.apiUrl;
  if (!upstream) return "not-configured";
  const identityToken = identityTokenFor(upstream);
  const tape = consoleTapeRouter({ upstream, identityToken });
  const billing = consoleBillingRouter({ upstream, identityToken });
  const codes = signInCodeMail();
  if (!host) {
    // No servicing hostname: development, where the console's dev server
    // proxies `/console/hm` here. Each door carries its own gate, so it is
    // safe on any Host; it is mounted on one only when there is one.
    app.use("/console/hm/tape", tape);
    app.use("/console/hm/billing", billing);
    return "not-configured";
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js → ../../console/dist in the image; src/ → the same in the repo.
  const dist = resolve(here, "../../console/dist");
  const built = existsSync(join(dist, "index.html"));
  const router = consoleHostRouter({
    host,
    upstream,
    dist: built ? dist : undefined,
    identityToken,
    tape,
    billing,
    ...(codes ? { codes } : {}),
  });
  app.use((req, res, next) => {
    if (hosts.has(req.hostname)) router(req, res, next);
    else next();
  });
  return built ? "console" : "proxy-only";
}
