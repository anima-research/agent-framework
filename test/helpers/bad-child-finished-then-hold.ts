/** The bad child's `finished-then-hold`, for a caller that can name only an entry: it ends its script and stays. */
process.argv[2] = 'finished-then-hold';
await import('./bad-child-entry.js');
