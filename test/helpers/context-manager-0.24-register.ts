/** `--import` this to run with context-manager 0.24.0's exports (context-manager-0.24.ts). */
import { register } from 'node:module';

register('./context-manager-0.24.js', import.meta.url);
