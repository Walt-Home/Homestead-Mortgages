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
 */

import express, { type Router } from "express";
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
): Promise<HttpResult<T>> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  for (const router of routers) app.use("/api/files", router);
  app.use(errorHandler);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/files${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        // A 204 has no body, and a delete is a request like any other: the
        // harness that could not read one is a harness that cannot test the
        // route where refusing and succeeding differ only by status.
        const text = await res.text();
        resolve({ status: res.status, body: (text ? JSON.parse(text) : {}) as T });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}
