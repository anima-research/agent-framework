/**
 * Presets — the historical agent kinds expressed as {@link AgentSpec}
 * values. They are configurations of the common machinery, not engines:
 * everything a preset decides is visible in the spec it returns, and a host
 * may register a spec that matches none of them.
 */

import type { AgentName, AgentSpec, ContextInheritance, ResultRoute } from './types.js';

/** Default idle bound for a bounded job with no explicit deadline (matches the run watchdog). */
export const DEFAULT_TASK_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * A resident: persistent, declared in configuration, reads the residents'
 * shared message slot. The first one declared owns default delivery.
 */
export function residentSpec(name: AgentName, options: { primary: boolean }): AgentSpec {
  return {
    name,
    kind: 'resident',
    roles: {
      defaultDelivery: options.primary,
      receivesUntargeted: true,
      receivesGateWakes: true,
      ownsProviderScheduling: true,
    },
    lifetime: { kind: 'persistent' },
    readsSharedSlot: true,
    namespace: `agents/${name}`,
  };
}

/**
 * The subconscious: a persistent attention tenant of the resident it
 * serves. It persists across policy epochs (cancelling a tune-out ends a
 * channel's cadence, not this agent), observes the residents' slot with
 * held traffic included, is never a broadcast recipient, and ends with its
 * resident.
 */
export function subconsciousSpec(name: AgentName, serves: AgentName): AgentSpec {
  return {
    name,
    kind: 'subconscious',
    roles: {
      defaultDelivery: false,
      receivesUntargeted: false,
      receivesGateWakes: false,
      ownsProviderScheduling: true,
    },
    lifetime: { kind: 'persistent' },
    spawnedBy: serves,
    onParentEnd: 'end',
    observes: [{ includeHeld: true }],
    resultTo: { to: serves, as: 'message' },
    readsSharedSlot: true,
    namespace: `subconscious/${serves}`,
  };
}

/**
 * A conversation fork: derived from a template agent's context at bind
 * time, bound to one channel, independent continuation, ends on idle.
 */
export function conversationForkSpec(
  name: AgentName,
  options: { template: AgentName; channelId: string; idleTtlMs: number; inherit?: Partial<ContextInheritance> },
): AgentSpec {
  return {
    name,
    kind: 'conversation-fork',
    roles: {
      defaultDelivery: false,
      receivesUntargeted: false,
      // Woken by its own channel's debounced traffic through the host-wide gate.
      receivesGateWakes: true,
      ownsProviderScheduling: false,
    },
    lifetime: { kind: 'idle', idleTtlMs: options.idleTtlMs },
    spawnedBy: options.template,
    onParentEnd: 'orphan',
    inherit: { from: options.template, mode: 'copy', ...options.inherit },
    // A copy renames the template's turns as it copies them. A shared
    // inheritance has no copy step, so the mapping is declared instead.
    ...(options.inherit?.mode === 'shared' ? { selfParticipants: [options.template] } : {}),
    homeChannel: options.channelId,
    namespace: `conversations/${name}`,
  };
}

export interface BoundedJobOptions {
  /** Who created it. Absent for an independent job driven by the host. */
  spawnedBy?: AgentName;
  /** Where its completion returns. */
  resultTo?: ResultRoute;
  deadlineMs?: number;
  idleTimeoutMs?: number;
  maxTurns?: number;
  namespace?: string;
  metadata?: Record<string, unknown>;
}

function boundedJob(name: AgentName, options: BoundedJobOptions): Omit<AgentSpec, 'kind'> {
  return {
    name,
    roles: {
      defaultDelivery: false,
      receivesUntargeted: false,
      receivesGateWakes: false,
      ownsProviderScheduling: false,
    },
    lifetime: {
      kind: 'task',
      ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_TASK_IDLE_TIMEOUT_MS,
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    },
    ...(options.spawnedBy ? { spawnedBy: options.spawnedBy, onParentEnd: 'orphan' as const } : {}),
    ...(options.resultTo ? { resultTo: options.resultTo } : {}),
    namespace: options.namespace ?? `subagent/${name}`,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

/** A fresh worker: new identity and context, one bounded job, a result route. */
export function workerSpec(name: AgentName, options: BoundedJobOptions = {}): AgentSpec {
  return { ...boundedJob(name, options), kind: 'worker' };
}

/**
 * A task fork: the parent's context at a checkpoint, a private
 * continuation, one bounded job, a return.
 */
export function taskForkSpec(
  name: AgentName,
  options: BoundedJobOptions & { parent: AgentName; inherit?: Partial<ContextInheritance> },
): AgentSpec {
  return {
    ...boundedJob(name, { ...options, spawnedBy: options.spawnedBy ?? options.parent }),
    kind: 'task-fork',
    inherit: { from: options.parent, mode: 'copy', ...options.inherit },
    ...(options.inherit?.mode === 'shared' ? { selfParticipants: [options.parent] } : {}),
  };
}
