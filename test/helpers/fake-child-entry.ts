/** A script's child on the stand-in engine, for the isolate's runner tests. */
import { childMain } from '../../src/code-execution/isolate/child-main.js';
import { loadFakeEngine } from './fake-engine.js';

childMain(loadFakeEngine);
