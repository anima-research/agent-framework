/**
 * Every agent's scripts: one kind of script, which runs in its agent's turn
 * and, past its bound, yields with its output so far and keeps running. The
 * agent then waits on it, stops it, or leaves it.
 *
 * - A left script that finishes cleanly, or that its agent stopped, says
 *   nothing; its result waits for a `wait` or a `list`, kept for the agent's
 *   newest ended scripts. One that fails, crashes or is stopped at its limit
 *   wakes its agent with its ending.
 * - Only the primary agent's scripts outlive a turn (any agent's, when no
 *   primary agent is named). Another agent's yield says so, and at its turn's
 *   end its running scripts are stopped, as "stopped at its limit". That stop
 *   wakes no one, since the agent was told at the yield.
 * - A turn that ends abnormally (a stream cancelled, an error, a quiesce)
 *   while a call still watches its script stops the script quietly if it
 *   hasn't returned yet; a wait it abandons leaves its script running, so a
 *   later failure still wakes the agent. A return made just before such an
 *   end counts as made, though its result is lost with the turn's.
 * - An agent has at most `maxRunning` scripts running, and the host at most
 *   its capacity of children.
 * - `wake_agent()` keeps today's spacing and cap: an early wake waits for its
 *   turn rather than being dropped, and past the cap it's refused. A wake
 *   still waiting for its turn when its script ends is never sent.
 *
 * The framework supplies what this can't know: the agent's tools now, the
 * dispatcher a script's calls go through, and how to wake an agent.
 */

import { NOTICE_TAG } from '../../notice-tags.js';
import { ChildCapacity, ScriptRun, type CallAnswer, type Ending, type ScriptRunOptions, type ToolAnswer } from './runner.js';
import type { CallSummary } from './calls.js';
import type { OutputBounds, OutputWindow } from './output.js';
import type { PreludeTool } from './prelude.js';
import { glimpse } from './render.js';
import { quotedJson, suppliedValue } from '../../supplied-text.js';

/** The run or wait call watching a script: its turn, which the script's calls carry, and whether one of them ended that turn. */
export interface ScriptWatch {
  turnId?: number;
  endTurn: boolean;
}

/** What the framework keeps with a script, handed back with each of its calls. */
export interface ScriptCallContext {
  /** RFC-007: what the script's calls are attributed to, its run call's origin. */
  origin?: unknown;
  /** The call watching the script when this call reached the host (`host.dispatch`), if one was: the call carries its turn. One the script made while watched that waited, with 16 of its calls already out, takes the watch as it stood when it went out, not when the script made it. */
  watch?: ScriptWatch;
  /** The call watching the script now, if one is: a result that ends the turn ends it at that call's return. Without it, `watch`. */
  watching?(): ScriptWatch | undefined;
  /** The turn the script's run call was made in, when one was: the turn its words were written in, which a later turn's wait doesn't change. */
  startTurnId?: number;
  /** What its agent had read when the run call started the script (the host's consumed watermark), given at run: what the script's words were written having read, which a later round's wait doesn't change. */
  startReadThrough?: { branch: string; sequence: number } | null;
}

export interface ScriptsHost {
  /** The tools a script of this agent may call now, without code_execution itself. */
  tools(agentName: string): PreludeTool[];
  /** The bridge: dispatch one of the script's calls as its agent's, through the ordinary dispatcher. Never rejects. */
  dispatch(agentName: string, toolName: string, argsJson: string, context: ScriptCallContext): Promise<ToolAnswer>;
  /** Wake the agent with this text: a script's wake_agent() payload, or a left script's ending. `label` names this wake, for a spilled copy. */
  wake(agentName: string, scriptId: string, text: string, label: string, startTurnId: number | undefined): Promise<void>;
  /** Whether this agent's scripts may outlive its turn. */
  outlivesTurn(agentName: string): boolean;
}

export interface ScriptsConfig {
  childEntry: string;
  execPath?: string;
  memoryMaxBytes: number;
  maxStackBytes?: number;
  output: OutputBounds;
  flushMs: number;
  /** The bound a run or wait yields at by default, and the most an agent may ask. */
  yieldMs: number;
  maxYieldMs: number;
  /** A script's limit. */
  lifetimeMs: number;
  toolCallTimeoutMs: number;
  stopGraceMs: number;
  /** Scripts one agent may have running at once, yielded ones included. */
  maxRunning: number;
  /** Ended scripts kept per agent for a later wait or list. */
  keepEnded: number;
  wakeMinIntervalMs: number;
  maxWakesPerScript: number;
}

/** What one run, wait or stop returns. */
export interface ScriptReturn {
  scriptId: string;
  /** Still running past the bound, or ended. */
  running: boolean;
  /** The output since this script's previous return. */
  output: OutputWindow;
  /** True for the script's first return. */
  first: boolean;
  calls: CallSummary;
  ending: Ending | null;
  /** True when this agent's script will be stopped at the end of its turn unless it waits for it. */
  stopsAtTurnEnd: boolean;
}

/** One script in a listing. */
export interface ScriptListing {
  scriptId: string;
  running: boolean;
  ending: Ending | null;
  startedAt: number;
  endedAt: number | null;
  /** The wakes the host delivered for it. */
  wakes: number;
}

interface Script {
  id: string;
  agentName: string;
  /** The code it runs. */
  code: string;
  run: ScriptRun;
  context: { origin?: unknown; startReadThrough?: { branch: string; sequence: number } | null };
  /** The turn its run call was made in, when one was: its agent's turns end it by that. */
  turnId: number | undefined;
  startedAt: number;
  endedAt: number | null;
  /** The order its ending came in among this host's: the newest ended are those kept. */
  endedSeq: number;
  /** The delivery of a wake it sent that may not have reached its agent yet: its ending's notice follows it. */
  delivering: Promise<void> | null;
  /** The call watching it now, if one is: its ending goes there, and its calls carry its turn. */
  watch: ScriptWatch | null;
  /** Its ending wakes no one: it was stopped where its agent was told it would be, or never saw it. */
  quietEnd: boolean;
  /** Its agent has gone: nothing can wait on it or list it, so it leaves the map once it has ended. */
  gone: boolean;
  /** Returns made so far. */
  returns: number;
  /** A call watching it has returned its ending, so a notice of the ending would only repeat it. */
  endingReturned: boolean;
}

/** Why a run, wait or stop couldn't be done: nothing was run or changed. */
export class ScriptRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptRefusal';
  }
}

/** The endings that wake a left script's agent: it didn't do its work, and not by its agent's choice. */
export function endingWakes(ending: Ending): boolean {
  return ending.how === 'failed' || ending.how === 'crashed' || (ending.how === 'stopped' && ending.reason === 'limit');
}

export class AgentScripts {
  private readonly scripts = new Map<string, Script>();
  /**
   * Marks this host's script ids, so an id from before a restart, still in an
   * agent's history, almost surely names no script of this one: four base-36
   * characters, so about one restart in 1.7 million draws the tag of the host
   * before it, and an old id could then name a new script of the same agent.
   */
  private readonly idTag = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  /** Every run whose child process hasn't exited, kept or not: dispose() ends any still alive. */
  private readonly live = new Set<ScriptRun>();
  private counter = 0;
  private endedCounter = 0;

  constructor(
    private readonly host: ScriptsHost,
    private readonly config: ScriptsConfig,
    private readonly capacity: ChildCapacity,
  ) {}

  /** The bound for this call: the agent's ask, capped, or the default. */
  bound(askedMs: number | undefined): number {
    return askedMs === undefined ? this.config.yieldMs : Math.min(askedMs, this.config.maxYieldMs);
  }

  async run(
    agentName: string,
    code: string,
    askedMs?: number,
    options: { origin?: unknown; watch?: ScriptWatch; startReadThrough?: { branch: string; sequence: number } | null } = {},
  ): Promise<ScriptReturn> {
    // Listed first, so a module whose tool list throws refuses the run with nothing taken.
    let tools: readonly PreludeTool[];
    try {
      tools = this.host.tools(agentName);
    } catch (err) {
      throw new ScriptRefusal(`The script's tools couldn't be listed: ${err instanceof Error ? err.message : String(err)}. Nothing was run.`);
    }
    const running = this.running(agentName);
    if (running >= this.config.maxRunning) {
      throw new ScriptRefusal(
        `You have ${running} scripts running, your most. Wait for one, stop one, or let one end before you start another. Nothing was run.`,
      );
    }
    if (!this.capacity.take()) {
      throw new ScriptRefusal(
        `This host is running ${this.capacity.running} scripts, its most. Try again once one has ended. Nothing was run.`,
      );
    }
    const id = `s${++this.counter}-${this.idTag}`;
    const script: Script = {
      id,
      agentName,
      code,
      run: null as unknown as ScriptRun,
      context: {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.startReadThrough === undefined ? {} : { startReadThrough: options.startReadThrough }),
      },
      turnId: options.watch?.turnId,
      startedAt: Date.now(),
      endedAt: null,
      endedSeq: 0,
      delivering: null,
      watch: options.watch ?? { endTurn: false },
      quietEnd: false,
      gone: false,
      returns: 0,
      endingReturned: false,
    };
    const runOptions: ScriptRunOptions = {
      childEntry: this.config.childEntry,
      ...(this.config.execPath ? { execPath: this.config.execPath } : {}),
      memoryMaxBytes: this.config.memoryMaxBytes,
      ...(this.config.maxStackBytes === undefined ? {} : { maxStackBytes: this.config.maxStackBytes }),
      output: this.config.output,
      flushMs: this.config.flushMs,
      lifetimeMs: this.config.lifetimeMs,
      toolCallTimeoutMs: this.config.toolCallTimeoutMs,
      stopGraceMs: this.config.stopGraceMs,
      wakeMinIntervalMs: this.config.wakeMinIntervalMs,
      maxWakes: this.config.maxWakesPerScript,
      onToolCall: (name, args) =>
        this.host.dispatch(agentName, name, args, {
          ...script.context,
          ...(script.watch ? { watch: script.watch } : {}),
          watching: () => script.watch ?? undefined,
          ...(script.turnId !== undefined ? { startTurnId: script.turnId } : {}),
        }),
      onWake: (payload, n) => this.wake(script, payload, n),
      onEnd: (ending) => this.ended(script, ending),
    };
    script.run = new ScriptRun(runOptions);
    const run = script.run;
    this.live.add(run);
    void run.exited.then(() => {
      this.live.delete(run);
      this.capacity.release();
    });
    try {
      script.run.start(code, tools);
    } catch (err) {
      // Nothing was spawned, and `exited` has resolved, which frees the place.
      throw new ScriptRefusal(`The script's process could not start: ${err instanceof Error ? err.message : String(err)}. Nothing was run.`);
    }
    this.scripts.set(id, script);
    // A script that ended at its start, before it was in the map, trimmed
    // without itself: the trim is taken again with it there.
    this.trimEnded(agentName);
    return this.observe(script, this.bound(askedMs), script.watch!);
  }

  async wait(agentName: string, scriptId: string, askedMs?: number, watch: ScriptWatch = { endTurn: false }): Promise<ScriptReturn> {
    const script = this.unwatched(this.own(agentName, scriptId));
    script.watch = watch;
    return this.observe(script, this.bound(askedMs), watch);
  }

  async stop(agentName: string, scriptId: string, watch: ScriptWatch = { endTurn: false }): Promise<ScriptReturn> {
    const script = this.unwatched(this.own(agentName, scriptId));
    script.watch = watch;
    // A run that has ended returns its ending to this stop: marked before the
    // stop yields, as observe marks a wait's, so a notice whose turn comes
    // first doesn't repeat it.
    if (script.run.ended) script.endingReturned = true;
    await script.run.stop('agent');
    return this.observe(script, 0, watch);
  }

  /** The code of this agent's script by that id, as a wait or a stop would find the script; undefined when the agent has none by it. */
  codeOf(agentName: string, scriptId: string): string | undefined {
    const script = this.scripts.get(scriptId);
    return script && script.agentName === agentName && !script.gone ? script.code : undefined;
  }

  list(agentName: string): ScriptListing[] {
    return [...this.scripts.values()]
      .filter((s) => s.agentName === agentName && !s.gone)
      .map((s) => ({
        scriptId: s.id,
        running: !s.run.ended,
        ending: s.run.snapshot().ending,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        wakes: s.run.wakesDelivered,
      }));
  }

  /**
   * An agent's turn ended: `turn.id`, with `turn.live` the agent's turns still
   * live (its open turn, and the turn of the stream that holds the agent), or
   * `'every'` when all its turns end at once (the host stopping, or a quiesce
   * that names no turn of its own).
   * Turns can overlap, a silent one beside an open one, so each script goes by
   * its own turn, the one its run call was made in. A turn that ended without
   * its calls' answers (`abandoned`) leaves its calls watching scripts with no
   * one to answer, whatever the agent: a script that hasn't returned yet is
   * stopped, and one that has is let go. An agent whose scripts don't outlive
   * a turn has stopped every script whose turn isn't live, and every one
   * started in no turn: a script lives while the turn that started it does.
   */
  turnEnded(agentName: string, turn: { id: number; live: readonly number[] } | 'every', abandoned: boolean, reason?: string): void {
    const outlives = this.host.outlivesTurn(agentName);
    for (const script of this.scripts.values()) {
      if (script.agentName !== agentName || script.gone || script.run.ended) continue;
      if (abandoned && script.watch && (turn === 'every' || script.watch.turnId === turn.id)) {
        if (script.returns === 0) {
          this.stopQuietly(script, `its turn ended before the script returned${reason ? ` (${reason})` : ''}`);
          continue;
        }
        script.watch = null;
      }
      if (outlives) continue;
      if (turn !== 'every' && script.turnId !== undefined && turn.live.includes(script.turnId)) continue;
      this.stopQuietly(script, "its agent's turn ended, and only the primary agent's scripts outlive a turn");
    }
  }

  /**
   * An agent that has gone, such as an ephemeral one whose run ended: its
   * scripts are stopped, and each leaves the map once it has ended, since no
   * later run of the agent will trim them.
   */
  agentGone(agentName: string): void {
    for (const script of [...this.scripts.values()]) {
      if (script.agentName !== agentName || script.gone) continue;
      if (script.run.ended) {
        this.scripts.delete(script.id);
        continue;
      }
      script.gone = true;
      this.stopQuietly(script, 'its agent ended');
    }
  }

  /** Stop every running script, as the framework stops, and end any child process still alive after its script's ending. */
  async dispose(): Promise<void> {
    const running = [...this.scripts.values()].filter((s) => !s.run.ended);
    for (const script of running) script.quietEnd = true;
    await Promise.all(running.map((s) => s.run.stop('limit', 'the host stopped')));
    await Promise.all([...this.live].map((run) => run.kill()));
  }

  /** Running scripts of this agent, yielded ones included; not those of an earlier agent of its name that has gone, which the host's count still holds. */
  running(agentName: string): number {
    return [...this.scripts.values()].filter((s) => s.agentName === agentName && !s.gone && !s.run.ended).length;
  }

  /** Running scripts that no call is watching: those acting outside any turn. */
  leftRunning(): number {
    return [...this.scripts.values()].filter((s) => !s.run.ended && s.watch === null).length;
  }

  private stopQuietly(script: Script, why: string): void {
    script.quietEnd = true;
    script.watch = null;
    void script.run.stop('limit', why);
  }

  private own(agentName: string, scriptId: string): Script {
    const script = this.scripts.get(scriptId);
    if (!script || script.agentName !== agentName || script.gone) {
      throw new ScriptRefusal(
        `You have no script ${JSON.stringify(scriptId)}: it isn't one of yours, it ran before this host restarted, ` +
          `or it ended and was dropped: only your ${this.config.keepEnded} newest ended scripts are kept, and none of an earlier agent of your name that has gone. Nothing was changed.`,
      );
    }
    return script;
  }

  /** A script no other call is watching now: one watching it gets its output and its ending. */
  private unwatched(script: Script): Script {
    if (script.watch !== null) {
      throw new ScriptRefusal(`Another of your calls is waiting on ${script.id} now, and its result will show how the script stands. Nothing was changed.`);
    }
    return script;
  }

  private async observe(script: Script, ms: number, watch: ScriptWatch): Promise<ScriptReturn> {
    // A run that has ended returns its ending at once: marked now, so a notice
    // whose turn comes before this return does doesn't repeat it. One that ends
    // while this call watches it gives no notice at all (ended), so this and a
    // stop's own, made before its stop yields, are the only marks a returned
    // ending needs.
    if (script.run.ended && script.watch === watch) script.endingReturned = true;
    const snap = await script.run.wait(ms);
    // A call whose turn was abandoned no longer watches the script: its
    // return reaches no one, so it takes none of the output from the next.
    const current = script.watch === watch;
    if (current) script.watch = null;
    if (current) script.returns += 1;
    return {
      scriptId: script.id,
      running: snap.ending === null,
      output: current ? script.run.takeOutput() : script.run.outputWindow(),
      first: script.returns <= 1,
      calls: snap.calls,
      ending: snap.ending,
      stopsAtTurnEnd: snap.ending === null && !this.host.outlivesTurn(script.agentName),
    };
  }

  private ended(script: Script, ending: Ending): void {
    script.endedAt = Date.now();
    script.endedSeq = ++this.endedCounter;
    if (script.gone) this.scripts.delete(script.id);
    else this.trimEnded(script.agentName);
    // A watched script's ending goes to the call watching it. A left one says
    // nothing when it finished or its agent stopped it, and wakes its agent
    // otherwise, after any wake it sent that is still being delivered: the
    // ending is the script's last word.
    if (script.watch || script.quietEnd || !endingWakes(ending)) return;
    const send = (): void => {
      // A wait or stop that took the ending while the notice waited has already given it.
      if (script.endingReturned) return;
      void this.host.wake(script.agentName, script.id, leftEndingText(script.id, ending), `${script.id}-ended`, script.turnId).catch(() => {});
    };
    if (script.delivering) void script.delivering.then(send);
    else send();
  }

  /** Send the script's `n`th wake, whose turn the run has waited for. */
  private async wake(script: Script, payloadJson: string, n: number): Promise<CallAnswer> {
    let delivery: Promise<void>;
    try {
      delivery = Promise.resolve(this.host.wake(
        script.agentName,
        script.id,
        wakeText(script.id, payloadJson, n, this.config.maxWakesPerScript, Date.now() - script.startedAt),
        `${script.id}-wake${n}`,
        script.turnId,
      ));
    } catch (err) {
      delivery = Promise.reject(err);
    }
    const done = delivery.then(() => {}, () => {});
    script.delivering = done;
    void done.then(() => {
      if (script.delivering === done) script.delivering = null;
    });
    try {
      await delivery;
      return { ok: true, json: 'null' };
    } catch (err) {
      return {
        ok: false,
        json: JSON.stringify({ name: 'WakeRefused', message: `the wake couldn't be delivered: ${err instanceof Error ? err.message : String(err)}` }),
      };
    }
  }

  /** Keep only the agent's newest ended scripts, newest by the order their endings came in. */
  private trimEnded(agentName: string): void {
    const ended = [...this.scripts.values()]
      .filter((s) => s.agentName === agentName && s.run.ended)
      .sort((a, b) => a.endedSeq - b.endedSeq);
    for (const s of ended.slice(0, Math.max(0, ended.length - this.config.keepEnded))) this.scripts.delete(s.id);
  }
}

function leftEndingText(scriptId: string, ending: Ending): string {
  const how = ending.how === 'failed'
    ? `failed: ${ending.error.name ? `${suppliedValue(ending.error.name)}: ` : ''}${suppliedValue(glimpse(ending.error.message, 300))}`
    : ending.how === 'crashed'
      ? `crashed: ${suppliedValue(ending.detail)}`
      : ending.how === 'stopped'
        ? ending.why ? `was stopped: ${suppliedValue(glimpse(ending.why, 300))}` : 'was stopped at its limit'
        : 'ended';
  return `[${NOTICE_TAG.script} ${scriptId}] Your script ${how}. {"action": "wait", "script_id": "${scriptId}"} gives its result.`;
}

function wakeText(scriptId: string, payloadJson: string, n: number, max: number, ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  return `[${NOTICE_TAG.script} ${scriptId}] Woke you with wake_agent(), ${minutes} min after it started (wake ${n} of ${max}): ${quotedJson(payloadJson)}`;
}
