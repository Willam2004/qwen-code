/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClientManager } from './mcp-client-manager.js';
import { MCPServerStatus } from './mcp-client.js';
import { getMCPServerHealth, removeMCPServerStatus } from './mcp-status.js';
import type { McpTransportPool } from './mcp-transport-pool.js';
import type { ToolRegistry } from './tool-registry.js';
import type { Config } from '../config/config.js';

vi.mock('./mcp-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('./mcp-client.js')>('./mcp-client.js');
  return {
    ...actual,
    McpClient: vi.fn(),
    populateMcpServerCommand: vi.fn((servers) => servers),
  };
});

const SERVER = 'aliyuncs-openapi';
const TRANSIENT_FAILURE = new Error(
  'failed to start: aliyuncs-openapi (connect ETIMEDOUT)',
);

type Rec = Record<string, unknown>;

function makeConfig(): Config {
  return {
    isTrustedFolder: () => true,
    getMcpServers: () => ({ [SERVER]: { command: 'node' } }),
    getMcpServerCommand: () => undefined,
    getTargetDir: () => '/session/worktree',
    getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
    getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
    getWorkspaceContext: () => ({}),
    getDebugMode: () => false,
    getSessionId: () => 'sid-1',
    isMcpServerDisabled: () => false,
  } as unknown as Config;
}

function pooledConn(): Rec {
  return {
    release: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    updateConfig: vi.fn(),
    id: `${SERVER}::abc`,
    transportId: `${SERVER}::abc`,
    serverName: SERVER,
    entryIndex: 0,
    client: { getStatus: () => MCPServerStatus.CONNECTED },
  };
}

function makePool(acquire: unknown): McpTransportPool {
  return {
    acquire,
    releaseSession: vi.fn(),
    getBudget: vi.fn().mockReturnValue(undefined),
  } as unknown as McpTransportPool;
}

function makeManager(
  pool: McpTransportPool,
  connectRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    enabled?: boolean;
  },
): McpClientManager {
  return new McpClientManager(
    makeConfig(),
    { removeMcpToolsByServer: vi.fn() } as unknown as ToolRegistry,
    { pool, ...(connectRetry ? { connectRetry } : {}) },
  );
}

describe('bounded MCP connect retry (DAT-2687)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    removeMCPServerStatus(SERVER);
  });

  it('recovers a server that fails once, without restarting the process', async () => {
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(TRANSIENT_FAILURE)
      .mockResolvedValueOnce(pooledConn());
    const manager = makeManager(makePool(acquire), { baseDelayMs: 1_000 });

    await manager.discoverAllMcpTools(makeConfig());

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(manager.getServerStatus(SERVER)).toBe(MCPServerStatus.DISCONNECTED);
    expect(manager.getMcpRetryState(SERVER)).toMatchObject({
      attempts: 1,
      exhausted: false,
    });
    expect(manager.getMcpRetryState(SERVER).nextRetryAt).toBeTypeOf('number');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(manager.getServerStatus(SERVER)).toBe(MCPServerStatus.CONNECTED);
    expect(manager.getMcpRetryState(SERVER)).toEqual({
      attempts: 0,
      exhausted: false,
      inFlight: false,
    });
    await manager.stop();
  });

  it('backs off exponentially and stops at the attempt cap', async () => {
    const acquire = vi.fn().mockRejectedValue(TRANSIENT_FAILURE);
    const manager = makeManager(makePool(acquire), {
      maxAttempts: 2,
      baseDelayMs: 100,
    });

    await manager.discoverAllMcpTools(makeConfig());
    expect(manager.getMcpRetryState(SERVER).attempts).toBe(1);

    // First retry fires after baseDelayMs (100ms).
    await vi.advanceTimersByTimeAsync(99);
    expect(acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(manager.getMcpRetryState(SERVER).attempts).toBe(2);

    // Second retry doubles to 200ms; no third hop once the cap is spent.
    await vi.advanceTimersByTimeAsync(199);
    expect(acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledTimes(3);

    expect(manager.getMcpRetryState(SERVER)).toMatchObject({
      attempts: 2,
      exhausted: true,
    });
    expect(manager.getMcpRetryState(SERVER).nextRetryAt).toBeUndefined();

    // Budget exhausted: no further acquires no matter how long we wait.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acquire).toHaveBeenCalledTimes(3);
    await manager.stop();
  });

  it('does not retry a permanent failure (auth)', async () => {
    const acquire = vi
      .fn()
      .mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    const manager = makeManager(makePool(acquire), { baseDelayMs: 100 });

    await manager.discoverAllMcpTools(makeConfig());

    expect(manager.getMcpRetryState(SERVER)).toMatchObject({
      attempts: 0,
      exhausted: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acquire).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it('stays inert when the policy is disabled (legacy default)', async () => {
    const acquire = vi.fn().mockRejectedValue(TRANSIENT_FAILURE);
    const manager = makeManager(makePool(acquire), { enabled: false });

    await manager.discoverAllMcpTools(makeConfig());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(manager.getMcpRetryState(SERVER).attempts).toBe(0);
    await manager.stop();
  });

  it('re-arms the retry when a live pooled transport drops', async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(pooledConn())
      .mockResolvedValueOnce(pooledConn());
    const pool = makePool(acquire);
    const manager = makeManager(pool, { baseDelayMs: 500 });

    await manager.discoverAllMcpTools(makeConfig());
    expect(acquire).toHaveBeenCalledTimes(1);

    const conn = acquire.mock.results[0]?.value
      ? ((await acquire.mock.results[0]!.value) as Rec)
      : undefined;
    const onFailed = (conn!['on'] as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === 'event',
    )?.[1] as (e: Rec) => void;
    expect(onFailed).toBeTypeOf('function');

    onFailed({ kind: 'failed', serverName: SERVER, lastError: 'EPIPE' });

    expect(manager.getMcpRetryState(SERVER)).toMatchObject({ attempts: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(acquire).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('exposes the failure cause and attempt time through the health view', async () => {
    const acquire = vi.fn().mockRejectedValue(TRANSIENT_FAILURE);
    const manager = makeManager(makePool(acquire), { baseDelayMs: 100 });

    await manager.discoverAllMcpTools(makeConfig());

    const health = getMCPServerHealth(SERVER);
    expect(health.status).toBe(MCPServerStatus.DISCONNECTED);
    expect(health.lastAttemptAt).toBeTypeOf('number');
    expect(health.lastError).toContain('failed to start: aliyuncs-openapi');
    await manager.stop();
  });
});
