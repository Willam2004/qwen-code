/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  getMCPServerHealth,
  getMCPServerLastError,
  MCPServerStatus,
  recordMCPServerAttempt,
  recordMCPServerLastError,
  removeMCPServerStatus,
  updateMCPServerStatus,
} from './mcp-status.js';

describe('mcp-status last-error carrier (issue #9944)', () => {
  // Discovery is best-effort and swallows connect errors (debugLogger only),
  // so the status enum alone cannot tell a consumer WHY a server is not
  // CONNECTED. The registry therefore carries the most recent failure cause
  // per server for consumers like `qwen mcp reconnect`.
  const serverName = 'last-error-carrier-server';

  afterEach(() => {
    removeMCPServerStatus(serverName);
  });

  it('returns undefined when no failure was recorded', () => {
    expect(getMCPServerLastError(serverName)).toBeUndefined();
  });

  it('round-trips a recorded failure cause', () => {
    recordMCPServerLastError(serverName, 'connect ECONNREFUSED 127.0.0.1:3939');
    expect(getMCPServerLastError(serverName)).toBe(
      'connect ECONNREFUSED 127.0.0.1:3939',
    );
  });

  it('keeps the most recent cause when failures repeat', () => {
    recordMCPServerLastError(serverName, 'first cause');
    recordMCPServerLastError(serverName, 'second cause');
    expect(getMCPServerLastError(serverName)).toBe('second cause');
  });

  it('keeps the recorded cause across DISCONNECTED status writes', () => {
    recordMCPServerLastError(serverName, 'HTTP 401 Unauthorized');
    updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);
    expect(getMCPServerLastError(serverName)).toBe('HTTP 401 Unauthorized');
  });

  it('clears the recorded cause when the server reaches CONNECTED', () => {
    recordMCPServerLastError(serverName, 'HTTP 401 Unauthorized');
    updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
    expect(getMCPServerLastError(serverName)).toBeUndefined();
  });

  it('clears the recorded cause when the server is removed from the registry', () => {
    recordMCPServerLastError(serverName, 'spawn ENOENT');
    removeMCPServerStatus(serverName);
    expect(getMCPServerLastError(serverName)).toBeUndefined();
  });
});

describe('mcp-status health view (DAT-2687)', () => {
  const serverName = 'health-view-server';

  afterEach(() => {
    removeMCPServerStatus(serverName);
  });

  it('reports disconnected with no attempt before anything happened', () => {
    expect(getMCPServerHealth(serverName)).toEqual({
      status: MCPServerStatus.DISCONNECTED,
    });
  });

  it('carries the last attempt time alongside the failure cause', () => {
    recordMCPServerAttempt(serverName, 1_700_000_000_000);
    recordMCPServerLastError(serverName, 'failed to start: aliyuncs-openapi');
    updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);

    expect(getMCPServerHealth(serverName)).toEqual({
      status: MCPServerStatus.DISCONNECTED,
      lastError: 'failed to start: aliyuncs-openapi',
      lastAttemptAt: 1_700_000_000_000,
    });
  });

  it('keeps lastAttemptAt but drops lastError after recovery', () => {
    recordMCPServerAttempt(serverName, 1_700_000_000_000);
    recordMCPServerLastError(serverName, 'spawn ENOENT');
    updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);

    expect(getMCPServerHealth(serverName)).toEqual({
      status: MCPServerStatus.CONNECTED,
      lastAttemptAt: 1_700_000_000_000,
    });
  });

  it('drops the attempt record when the server is removed', () => {
    recordMCPServerAttempt(serverName, 1_700_000_000_000);
    recordMCPServerLastError(serverName, 'spawn ENOENT');
    removeMCPServerStatus(serverName);

    expect(getMCPServerHealth(serverName)).toEqual({
      status: MCPServerStatus.DISCONNECTED,
    });
  });
});
