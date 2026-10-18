/**
 * McplServerRegistry — manages all connected MCPL server connections.
 *
 * Provides lookup by id, capability filtering, and feature set matching.
 */

import type { McplServerConfig, McplHostCapabilities } from './types.js';
import { McplServerConnection, McplUnreapedLaunchError } from './server-connection.js';
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
  /** Ids whose addServer is still connecting. A second add for one is
   *  refused, so a failed launch's closed connection can always be registered
   *  as the owner of a child it couldn't reap. */
  private adding = new Set<string>();
  private closing = new Map<McplServerConnection, Promise<void>>();

  /**
   * Connect to an MCPL server and register it.
   *
   * Throws if a server with the same id is already registered, or if
   * the connection/handshake fails. A failed launch whose child couldn't be
   * confirmed exited stays registered all the same, as the closed connection
   * that owns it ({@link McplUnreapedLaunchError}), so the id stays held
   * and removeServer can retry the reap.
   */
  async addServer(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
    signal?: AbortSignal,
  ): Promise<McplServerConnection> {
    if (this.servers.has(config.id) || this.adding.has(config.id)) {
      throw new Error(`MCPL server "${config.id}" is already registered`);
    }

    this.adding.add(config.id);
    let connection: McplServerConnection;
    try {
      connection = config.reconnect === true
        ? await McplServerConnection.connectWithReconnect(config, hostCapabilities, signal)
        : await McplServerConnection.connect(config, hostCapabilities, signal);
    } catch (error) {
      if (error instanceof McplUnreapedLaunchError) this.register(config, error.connection);
      throw error;
    } finally {
      this.adding.delete(config.id);
    }
    this.register(config, connection);
    return connection;
  }

  private register(config: McplServerConfig, connection: McplServerConnection): void {
    this.servers.set(config.id, connection);

    // Auto-remove on close unless the connection will reconnect. That was
    // decided once, from `reconnect === true` at connect, and a close() the
    // host asks for disarms it first, so a server closed for good goes too.
    // A connection that still owns a child it couldn't reap keeps its id, so
    // nothing launches beside that child; removeServer retries the reap.
    connection.on('close', () => {
      if (!connection.willReconnect && this.servers.get(config.id) === connection && !connection.holdsUnreapedChild) {
        this.servers.delete(config.id);
      }
    });

    // Re-emit reconnect events for observability
    connection.on('reconnect', () => {
      // Connection already in the map — capabilities may have changed
    });
  }

  /**
   * Disconnect and remove a server by id.
   *
   * No-op if the server is not registered. If its close can't confirm the
   * child exited, it stays registered and the failure is thrown: removing it
   * again retries the reap.
   */
  async removeServer(id: string): Promise<void> {
    const connection = this.servers.get(id);
    if (!connection) {
      return;
    }
    // The id stays held until the close settles, so nothing launches beside
    // a child still being reaped; it's freed only once the exit is confirmed.
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
   * Close every server connection. Each one whose close confirms its exit
   * is removed. One whose close fails or is still pending stays registered,
   * holding its id, and every failure is thrown; removeServer or a later
   * closeAll retries it. An explicit timeout bounds the caller's wait
   * without cancelling cleanup.
   */
  async closeAll(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    validateShutdownTimeout(timeoutMs);
    await waitForShutdown(Array.from(this.servers, ([id, connection]) => ({
      label: `mcpl:${id}`, promise: this.closeServer(id, connection),
    })), timeoutMs);
  }

  /**
   * Close a server for good and drop its entry, if this connection is still
   * the one registered under `id`. The entry goes when close() resolves,
   * whatever the connection reports: close() emits no 'close' for a
   * connection that's down between retries, such as a reconnect stub waiting
   * for its next retry, so the 'close' listener alone would leave it
   * registered. A close that fails keeps the entry and rejects; a close
   * already under way is shared.
   */
  closeServer(id: string, connection: McplServerConnection): Promise<void> {
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
