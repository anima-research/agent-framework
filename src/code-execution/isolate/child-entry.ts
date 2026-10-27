/** The script the parent spawns for each script: the child, on the engine. */
import { loadEngine } from '../engine.js';
import { childMain } from './child-main.js';

childMain(loadEngine);
