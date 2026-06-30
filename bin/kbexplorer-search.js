#!/usr/bin/env node
/**
 * Thin executable wrapper for the kbexplorer-search CLI.
 *
 * Keeps the shebang out of the TypeScript sources (tsc does not preserve it)
 * and delegates to the compiled entrypoint in dist/.
 */
import { main } from '../dist/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
