import type { TraceEventInput } from '../src/types/trace.js';
import type { AgentFramework } from '../src/framework.js';
import type { EventGate } from '../src/gate/event-gate.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { PushHandler } from '../src/mcpl/push-handler.js';
import type { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';
import type { InferenceRouter } from '../src/mcpl/inference-router.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';

type Is<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Takes<Raise extends (event: never) => void> = Is<Parameters<Raise>[0], TraceEventInput>;
type Holds<Check extends true> = Check;

function raisesOnlyListedTraces(raise: (event: TraceEventInput) => void): void {
  // @ts-expect-error a trace whose name the union doesn't list
  raise({ type: 'not:a-listed-trace' });
  // @ts-expect-error a listed trace without its member's fields
  raise({ type: 'tool:failed' });
  // @ts-expect-error a field its member doesn't declare
  raise({ type: 'mcpl:coalescing', kind: 'revoked', subject: 's', eventId: 'e', unlisted: true });
}
void raisesOnlyListedTraces;

type FrameworkRaise = Holds<Takes<AgentFramework['emitTrace']>>;
type GateHook = Holds<Takes<ConstructorParameters<typeof EventGate>[0]['emitTrace']>>;
type ChannelsHook = Holds<Takes<ConstructorParameters<typeof ChannelRegistry>[3]>>;
type PushHook = Holds<Takes<ConstructorParameters<typeof PushHandler>[2]>>;
type CheckpointHook = Holds<Takes<ConstructorParameters<typeof CheckpointManager>[1]>>;
type InferenceHook = Holds<Takes<ConstructorParameters<typeof InferenceRouter>[4]>>;
type FeatureSetHook = Holds<Takes<NonNullable<ConstructorParameters<typeof FeatureSetManager>[0]>>>;
type TuneOutHook = Holds<Takes<TuneOutFrameworkHooks['emitTrace']>>;
