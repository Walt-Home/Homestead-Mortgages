import { Router } from "express";
import { REQUIREMENTS } from "@hm/requirements";
import { SHADOW_ENGINE_VERSION } from "@hm/underwriting";
import { config } from "../config.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "homestead-mortgages-api",
    version: "0.1.0",
    requirementCount: REQUIREMENTS.length,
    ausEngine: `shadow@${SHADOW_ENGINE_VERSION}`,
    connectorMode: config.connectorMode,
    timestamp: new Date().toISOString(),
  });
});
