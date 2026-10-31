import { Command } from 'commander';

export function createProgram(version: string): Command {
  const program = new Command()
    .name('dark')
    .description(
      'DarkFactory — an autonomous software factory powered by AI agents.',
    )
    .version(version)
    .showHelpAfterError('(Run dark --help for usage.)');

  program.action(() => {
    program.outputHelp();
  });

  return program;
}
