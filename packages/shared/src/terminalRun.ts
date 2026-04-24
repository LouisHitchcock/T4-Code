export const BANG_COMMAND_TERMINAL_ID_PREFIX = "bang-command-";

export function buildBangCommandTerminalId(id: string): string {
  return `${BANG_COMMAND_TERMINAL_ID_PREFIX}${id}`;
}

export function isBangCommandTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(BANG_COMMAND_TERMINAL_ID_PREFIX);
}
