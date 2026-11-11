// @req FR-03
// Issue #236: a custom command is an argv, never a shell string.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTypechecker } from '../src/probe/typecheck.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { stubTscProject as stubProject, tmpDir as tmp, writeIn as write, cleanupProjects } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('a custom command is an argv, never a shell string', () => {
  const script = (dir, body) => { write(dir, 'check.mjs', body); return `${process.execPath} check.mjs`; };

  it('passes quoted words literally: no expansion, no operators', async () => {
    const dir = tmp();
    const out = join(dir, 'argv.json');
    const command = `${script(dir, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`)} "a;b" '$(touch pwned)' && echo hi`;
    const checker = await createTypechecker({ projectDir: dir, command });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['a;b', '$(touch pwned)', '&&', 'echo', 'hi']);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    checker.cleanup();
  });

  it('a nonzero exit is diagnostics naming the first line that says error; its identity and version are recorded', async () => {
    const dir = tmp();
    const command = script(dir, "import { existsSync } from 'node:fs'; if (existsSync('bad')) { console.log('checking...'); console.log('src/a.ts: error: boom'); process.exit(1); }");
    const checker = await createTypechecker({ projectDir: dir, command });
    expect(checker.spec.version).toMatch(/^v\d+\./); // `node --version`
    write(dir, 'bad', '');
    expect(await checker.check()).toMatchObject({ status: 'diagnostics', message: 'src/a.ts: error: boom' });
    rmSync(join(dir, 'bad'));
    expect((await checker.check()).status).toBe('clean');
    expect(checker.applicable('a.js')).toBe(false); // a custom command cannot say what it checks
    expect(checker.applicable('a.ts')).toBe(true);
    checker.cleanup();
    const other = await createTypechecker({ projectDir: dir, command: `${command} --strict` });
    expect(other.spec.commandHash).not.toBe(checker.spec.commandHash);
    other.cleanup();
  });

  it('a command that is not there, or whose baseline fails, is a precondition error', async () => {
    await expect(createTypechecker({ projectDir: tmp(), command: 'tg-no-such-checker --x' })).rejects.toThrow(/command not found/);
    const dir = tmp();
    await expect(createTypechecker({ projectDir: dir, command: script(dir, "console.log('first problem'); process.exit(1);") })).rejects.toThrow(/does not type-check[\s\S]*first problem/);
    await expect(createTypechecker({ projectDir: dir, command: '"unterminated' })).rejects.toThrow(/unterminated quote/);
  });
});

