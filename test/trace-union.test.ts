import type { TraceEventInput } from '../src/types/trace.js';
import type { EventGate } from '../src/gate/event-gate.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { PushHandler } from '../src/mcpl/push-handler.js';
import type { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';
import type { InferenceRouter } from '../src/mcpl/inference-router.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';

type Unlisted = { type: 'not:a-listed-trace' };
type Takes<Hook extends (event: never) => void, Event extends Parameters<Hook>[0]> = Event;

function unlistedTraceRefused(raise: (event: TraceEventInput) => void): void {
  // @ts-expect-error a trace whose name the union doesn't list
  raise({ type: 'not:a-listed-trace' });
}
void unlistedTraceRefused;

// @ts-expect-error EventGate's hook takes only the union's traces
type GateHook = Takes<ConstructorParameters<typeof EventGate>[0]['emitTrace'], Unlisted>;
// @ts-expect-error ChannelRegistry's hook takes only the union's traces
type ChannelsHook = Takes<ConstructorParameters<typeof ChannelRegistry>[3], Unlisted>;
// @ts-expect-error PushHandler's hook takes only the union's traces
type PushHook = Takes<ConstructorParameters<typeof PushHandler>[2], Unlisted>;
// @ts-expect-error CheckpointManager's hook takes only the union's traces
type CheckpointHook = Takes<ConstructorParameters<typeof CheckpointManager>[1], Unlisted>;
// @ts-expect-error InferenceRouter's hook takes only the union's traces
type InferenceHook = Takes<ConstructorParameters<typeof InferenceRouter>[4], Unlisted>;
// @ts-expect-error FeatureSetManager's hook takes only the union's traces
type FeatureSetHook = Takes<NonNullable<ConstructorParameters<typeof FeatureSetManager>[0]>, Unlisted>;
// @ts-expect-error the tune-out coordinator's hook takes only the union's traces
type TuneOutHook = Takes<TuneOutFrameworkHooks['emitTrace'], Unlisted>;
