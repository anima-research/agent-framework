import type { TraceEvent, TraceEventInput } from '../src/types/trace.js';
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

type RequiredKeys<Event> = Event extends unknown
  ? { [Key in keyof Event]-?: {} extends Pick<Event, Key> ? never : Key }[keyof Event]
  : never;
type WithIndex<Event> = Event extends unknown ? (string extends keyof Event ? Event : never) : never;
type WithTimestamp<Event> = Event extends unknown ? ('timestamp' extends keyof Event ? Event : never) : never;
type FieldsNotRequired = {
  [Name in TraceEvent['type']]: Is<
    RequiredKeys<Extract<TraceEventInput, { type: Name }>>,
    Exclude<RequiredKeys<Extract<TraceEvent, { type: Name }>>, 'timestamp'>
  > extends true ? never : Name;
}[TraceEvent['type']];

type RefusesAnUnlistedName = Holds<Is<'not:a-listed-trace' extends TraceEventInput['type'] ? true : false, false>>;
type RequiresEachMembersFields = Holds<Is<FieldsNotRequired, never>>;
type RefusesAnUndeclaredField = Holds<Is<WithIndex<TraceEventInput>, never>>;
type RefusesATimestamp = Holds<Is<WithTimestamp<TraceEventInput>, never>>;
type ToolFailedErrorIsAString = Holds<Is<Extract<TraceEvent, { type: 'tool:failed' }>['error'], string>>;

type FrameworkRaise = Holds<Takes<AgentFramework['emitTrace']>>;
type GateHook = Holds<Takes<ConstructorParameters<typeof EventGate>[0]['emitTrace']>>;
type ChannelsHook = Holds<Takes<ConstructorParameters<typeof ChannelRegistry>[3]>>;
type PushHook = Holds<Takes<ConstructorParameters<typeof PushHandler>[2]>>;
type CheckpointHook = Holds<Takes<ConstructorParameters<typeof CheckpointManager>[1]>>;
type InferenceHook = Holds<Takes<ConstructorParameters<typeof InferenceRouter>[4]>>;
type FeatureSetHook = Holds<Takes<NonNullable<ConstructorParameters<typeof FeatureSetManager>[0]>>>;
type TuneOutHook = Holds<Takes<TuneOutFrameworkHooks['emitTrace']>>;

type NotCastable = { [Name in TraceEvent['type']]: Extract<TraceEvent, { type: Name }> extends Record<string, unknown> ? never : Name }[TraceEvent['type']];
type EveryMemberTakesTheCast = Holds<Is<NotCastable, never>>;
