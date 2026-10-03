/**
 * McplServerRegistry — manages all connected MCPL server connections.
 *
 * Provides lookup by id, capability filtering, and feature set matching.
 */

import type { McplServerConfig, McplHostCapabilities } from './types.js';
import { McplServerConnection } from './server-connection.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, validateShutdownTimeout, waitForShutdown } from '../shutdown.js';

/**
 * Capability keys that can be queried via `getServersWithCapability`.
 */
export type McplCapabilityQuery =
  | 'pushEvents'
  | 'contextHooks.beforeInference'
  | 'contextHooks.afterInference'
  | 'inferenceRequest'
  | 'modelInfo';

/**
 * Container that manages all connected MCPL servers.
 *
 * Provides methods to add/remove servers, look up by id, and query
 * servers by advertised capabilities or feature set names.
 */
export class McplServerRegistry {
  private servers = new Map<string, McplServerConnection>();
  private closing = new Map<McplServerConnection, Promise<void>>();

  /**
   * Connect to an MCPL server and register it.
   *
   * Throws if a server with the same id is already registered, or if
   * the connection/handshake fails.
   */
  async addServer(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    if (this.servers.has(config.id)) {
      throw new Error(`MCPL server "${config.id}" is already registered`);
    }

    const connection = config.reconnect
      ? await McplServerConnection.connectWithReconnect(config, hostCapabilities)
      : await McplServerConnection.connect(config, hostCapabilities);
    this.servers.set(config.id, connection);

    // Auto-remove on unexpected close (unless reconnect will re-add)
    connection.on('close', () => {
      if (!config.reconnect) {
        this.servers.delete(config.id);
      }
    });

    // Re-emit reconnect events for observability
    connection.on('reconnect', () => {
      // Connection already in the map — capabilities may have changed
    });

    return connection;
  }

  /**
   * Disconnect and remove a server by id.
   *
   * No-op if the server is not registered.
   */
  async removeServer(id: string): Promise<void> {
    const connection = this.servers.get(id);
    if (!connection) {
      return;
    }
    await this.closeServer(id, connection);
  }

  /**
   * Get a server connection by id, or null if not found.
   */
  getServer(id: string): McplServerConnection | null {
    return this.servers.get(id) ?? null;
  }

  /**
   * Get all currently connected servers.
   */
  getAllServers(): McplServerConnection[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get all servers that advertise a specific capability.
   *
   * Supported capability queries:
   * - `'pushEvents'`                   — `capabilities.pushEvents === true`
   * - `'contextHooks.beforeInference'`  — `capabilities.contextHooks?.beforeInference === true`
   * - `'contextHooks.afterInference'`   — `capabilities.contextHooks?.afterInference` is truthy
   * - `'inferenceRequest'`              — `capabilities.inferenceRequest` is truthy
   * - `'modelInfo'`                     — `capabilities.modelInfo === true`
   */
  getServersWithCapability(cap: McplCapabilityQuery): McplServerConnection[] {
    return this.getAllServers().filter((server) => {
      const caps = server.capabilities;
      if (!caps) return false;

      switch (cap) {
        case 'pushEvents':
          return caps.pushEvents === true;
        case 'contextHooks.beforeInference':
          // Truthy, not ===true: §5.1 shorthand is expanded to the object
          // form at handshake. (Prefer connection.grant for authorization —
          // this query is advertisement-level only.)
          return !!caps.contextHooks?.beforeInference;
        case 'inferenceRequest':
          return !!caps.inferenceRequest;
        case 'modelInfo':
          return caps.modelInfo === true;
        default:
          return false;
      }
    });
  }

  /**
   * Get all servers that declare a feature set with the given name.
   *
   * Checks `capabilities.featureSets` for a key matching `featureSet`.
   */
  getServersForFeatureSet(featureSet: string): McplServerConnection[] {
    return this.getAllServers().filter((server) => {
      const caps = server.capabilities;
      if (!caps?.featureSets) return false;
      return featureSet in caps.featureSets;
    });
  }

  /**
   * Close all server connections and clear the registry.
   */
  async closeAll(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    validateShutdownTimeout(timeoutMs);
    await waitForShutdown(Array.from(this.servers, ([id, connection]) => ({
      label: `mcpl:${id}`, promise: this.closeServer(id, connection),
    })), timeoutMs);
  }

  private closeServer(id: string, connection: McplServerConnection): Promise<void> {
    const existing = this.closing.get(connection);
    if (existing) return existing;
    const attempt = Promise.resolve().then(() => connection.close()).then(() => {
      if (this.servers.get(id) === connection) this.servers.delete(id);
      this.closing.delete(connection);
    }, error => {
      this.closing.delete(connection);
      throw error;
    });
    this.closing.set(connection, attempt);
    return attempt;
  }
}
