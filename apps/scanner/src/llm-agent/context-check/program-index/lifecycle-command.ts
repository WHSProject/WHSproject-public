import { posix } from 'node:path';

export interface LifecycleCommand {
  /** Package-relative files the command is shown to run with node, in order. */
  files: string[];
  /** Part of the command could not be read statically and was not followed. */
  notStatic: boolean;
}

const MAX_SCRIPT_DEPTH = 5;
const NODE = new Set(['node', 'nodejs']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn']);
const INLINE_CODE = new Set(['-e', '--eval', '-p', '--print', '-']);
const PRELOAD = new Set(['-r', '--require', '--import']);

const unquote = (token: string): string => token.replace(/^(["'])(.*)\1$/u, '$2');
const isStatic = (token: string): boolean => !/[$`*?<>(){}]/u.test(token);

/**
 * Reads an npm script as a chain of static commands: `node file`, `cd dir`,
 * `npm run name`, joined by `&&` or `;`. Anything else (a part after `||` or a
 * pipe, a variable, a substitution, another interpreter, inline code) is not
 * followed.
 */
export function readLifecycleCommand(command: string, scripts: Readonly<Record<string, string>> = {}, seen: ReadonlySet<string> = new Set()): LifecycleCommand {
  const result: LifecycleCommand = { files: [], notStatic: false };
  if (/`|\$\(/u.test(command) || seen.size > MAX_SCRIPT_DEPTH) return { files: [], notStatic: true };
  const parts = command.split(/(&&|\|\||;|\||&)/u);
  let directory = '';
  for (let position = 0; position < parts.length; position += 2) {
    const separator = position === 0 ? '' : parts[position - 1];
    const tokens = (parts[position] ?? '').trim().split(/\s+/u).filter(Boolean).map(unquote);
    // Whether a part after `||` or behind a pipe runs depends on what came before it.
    if (separator === '||' || separator === '|') { result.notStatic = true; continue; }
    while (tokens.length > 0 && /^[A-Za-z_]\w*=/u.test(tokens[0]!) && isStatic(tokens[0]!)) tokens.shift();
    if (tokens.length === 0) continue;
    if (!tokens.every(isStatic)) { result.notStatic = true; continue; }
    const [program, ...args] = tokens;
    if (program === 'cd' && args.length === 1) { directory = posix.join(directory, args[0]!); continue; }
    if (NODE.has(program!)) {
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (INLINE_CODE.has(arg)) { result.notStatic = true; break; }
        if (PRELOAD.has(arg)) { const file = args[index + 1]; if (file?.startsWith('.')) result.files.push(posix.join(directory, file)); index += 1; continue; }
        if (arg.startsWith('-')) continue;
        result.files.push(posix.join(directory, arg));
        break;
      }
      continue;
    }
    const name = RUNNERS.has(program!) && (args[0] === 'run' || args[0] === 'run-script') ? args[1] : undefined;
    const script = name === undefined ? undefined : scripts[name];
    // npm runs a script from the package root, wherever it was called from.
    if (name !== undefined && script !== undefined && !seen.has(name)) {
      const nested = readLifecycleCommand(script, scripts, new Set([...seen, name]));
      result.files.push(...nested.files);
      result.notStatic ||= nested.notStatic;
      continue;
    }
    result.notStatic = true;
  }
  return { files: [...new Set(result.files)], notStatic: result.notStatic };
}
