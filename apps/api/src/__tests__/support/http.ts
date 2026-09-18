/**
 * A route, called the way Express calls it.
 *
 * The routers are mounted where index.ts mounts them and the error handler is
 * the real one, so a test sees the status and body a client would. What is
 * left out is the session: `req.user` is set directly from the row, because
 * the thing under test is what a signed-in person's request does, not how
 * they signed in — `access.test.ts` covers the gate itself.
 *
 * One server per call. A handful of requests per test is the expected load,
 * and a listener that outlives its test is a leak the next file inherits.
 *
 * The request gets a connection of its own — `agent: false` — and that is not
 * a detail. A client that pools connections keys its idle sockets by origin,
 * and every server here is `http://127.0.0.1:<whatever port the kernel had
 * free>`. Ports come back around: when a later server was handed one an
 * earlier server had just released, the origin matched a socket still sitting
 * in the pool, and the pool handed back a connection to a server that no
 * longer existed. The request died with "other side closed" against a route it
 * never reached, in whichever file happened to draw the repeated port, so the
 * suite failed for a reason that had nothing to do with the code under test. A
 * connection that belongs to one request cannot outlive the server it was
 * opened against.
 */

import express, { type Router } from "express";
import { request as httpRequest } from "node:http";
import { prisma } from "@hm/db";
import { errorHandler } from "../../middleware/error-handler.js";

export interface HttpResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: T;
}

export async function callAs<T = Record<string, unknown>>(
  userId: string,
  routers: readonly Router[],
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  /** Where the routers hang. The file routers are the common case. */
  mount = "/api/files",
): Promise<HttpResult<T>> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    // A router that sits behind `requireAuth` reads the session and loads the
    // user itself, so the stub has to be here too — the thing under test is
    // still what a signed-in person's request does, not how they signed in.
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId,
      // The second step of sign-in, already done. The same stub as `userId`
      // and for the same reason: a route's test is about what a signed-in
      // person's request does, and `second-factor.test.ts` is where the
      // gate itself is walked through a real session.
      secondFactor: "verified",
      // Enough of express-session for the routes that rotate or end one. A
      // real store would prove nothing here and would need a second database.
      destroy: (cb: () => void) => cb(),
      regenerate: (cb: () => void) => cb(),
    };
    next();
  });
  for (const router of routers) app.use(mount, router);
  app.use(errorHandler);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method,
          path: `${mount}${path}`,
          headers: { "content-type": "application/json" },
          agent: false,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            server.close();
            // A 204 has no body, and a delete is a request like any other: the
            // harness that could not read one is a harness that cannot test the
            // route where refusing and succeeding differ only by status.
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: (text ? JSON.parse(text) : {}) as T,
              });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  });
}
