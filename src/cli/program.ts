import { Command } from 'commander';

export function createProgram(version: string): Command {
  const program = new Command()
    .name('dark')
    .description(
      'DarkFactory — an autonomous software factory powered by AI agents.',
    )
    .version(version)
    .showHelpAfterError('(Run dark --help for usage.)');

  program
    .command('start')
    .description('Run the default workflow from issue exploration to delivery')
    .option('-i, --issue <text>', 'Issue to explore (otherwise prompt)')
    .option('--debug', 'Stream agent activity instead of Observer summaries')
    .option(
      '-c, --config <path>',
      'Factory configuration file',
      'factory.config.json',
    )
    .action(
      async (options: { config: string; issue?: string; debug?: boolean }) => {
        const { startCommand } = await import('./start.js');
        await startCommand(options);
      },
    );

  // Keep the scaffold's strict unknown-argument behavior on the root command.
  program.allowExcessArguments(false);

  program.action(() => {
    program.outputHelp();
  });

  return program;
}
