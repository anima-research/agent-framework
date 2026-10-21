import type { EventGate } from '../../src/gate/event-gate.js';

/** The names the framework tells the gate are gone, through agentGone(),
 *  whose self-wake rule the gate's own tests check. */
export function goneNames(gate: EventGate): string[] {
  const gone: string[] = [];
  const agentGone = gate.agentGone.bind(gate);
  gate.agentGone = (name: string) => { gone.push(name); agentGone(name); };
  return gone;
}
