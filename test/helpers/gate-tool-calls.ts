/** What the gate's sleep and wake tools answered, as the framework queued
 *  each result: `tool: error` for a refused call, and the calls that started
 *  (a refusal starts none). */
export function gateToolCalls(framework: { onTrace(listener: (event: unknown) => void): unknown }): { refused: string[]; succeeded: string[]; started: string[] } {
  const calls = { refused: [] as string[], succeeded: [] as string[], started: [] as string[] };
  framework.onTrace((e) => {
    const traced = e as { type?: string; module?: string; tool?: string; processEvent?: { type?: string; toolName?: string; moduleName?: string; result?: { refused?: boolean; success?: boolean; error?: string } } };
    if (traced.type === 'tool:started' && traced.module === 'gate') calls.started.push(String(traced.tool));
    const ev = traced.processEvent;
    if (traced.type === 'process:received' && ev?.type === 'tool-result' && ev.moduleName === 'gate' && (ev.toolName === 'sleep' || ev.toolName === 'wake')) {
      if (ev.result?.refused === true) calls.refused.push(`${ev.toolName}: ${ev.result.error}`);
      else if (ev.result?.success === true) calls.succeeded.push(String(ev.toolName));
    }
  });
  return calls;
}
