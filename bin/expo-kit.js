#!/usr/bin/env node

const COMMANDS = {
  release: { module: '../src/release/cli', summary: 'one-command App Store + Google Play release' },
};

const [command, ...args] = process.argv.slice(2);
if (!COMMANDS[command]) {
  const list = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(10)}${c.summary}`);
  console.error(['usage: expo-kit <command> [--help]', '', 'commands:', ...list].join('\n'));
  process.exit(command && command !== '--help' ? 1 : 0);
}
require(COMMANDS[command].module).run(args);
