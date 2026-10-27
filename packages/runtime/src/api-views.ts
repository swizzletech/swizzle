// The serializers that project platform records into the shapes http-contract.ts names. Each
// returns its contract type, so a field the contract does not list cannot leave the API.

import type { ConnectionView } from "@swizzle/db";

import type { ConnectionResponse, DeploymentResponse, RunResponse } from "./http-contract.js";
import type { PlatformDeploymentRecord, PlatformRunDetail } from "./platform-records.js";

export function deploymentResponse(deployment: PlatformDeploymentRecord): DeploymentResponse {
  return {
    artifactRootPath: deployment.artifactRootPath,
    automationName: deployment.automationName,
    buildSnapshot: deployment.buildSnapshot,
    config: deployment.config,
    connectionHealth: deployment.connectionHealth,
    deployedAt: deployment.deployedAt,
    deploymentId: deployment.deploymentId,
    readiness: deployment.readiness,
    runtimeSnapshot: deployment.runtimeSnapshot,
    secretHealth: deployment.secretHealth,
    seq: deployment.seq,
    sourceHash: deployment.sourceHash,
    triggerType: deployment.triggerType,
    vars: { ...deployment.config.vars },
    version: deployment.version,
    versionId: deployment.versionId,
  };
}

export function runResponse(run: PlatformRunDetail, dashboardUrl: string | null): RunResponse {
  return { ...run, dashboardUrl };
}

export function connectionResponse(connection: ConnectionView): ConnectionResponse {
  return {
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    authorizationPending: connection.authorizationPending,
    clientId: connection.clientId,
    createdAt: connection.createdAt,
    environment: connection.environment,
    id: connection.id,
    lastErrorAt: connection.lastErrorAt,
    lastErrorCode: connection.lastErrorCode,
    lastRefreshedAt: connection.lastRefreshedAt,
    name: connection.name,
    project: connection.project,
    provider: connection.provider,
    scopes: connection.scopes,
    status: connection.status,
    tokenVersion: connection.tokenVersion,
    updatedAt: connection.updatedAt,
  };
}
