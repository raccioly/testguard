// @req NFR-05
import { describe, it, expect } from 'vitest';
import { progressMode, stageReporter, clearStageLine, recordEvent, isProgressMode, progressStream } from '../src/probe/progress.mjs';

const capture = () => { const lines = []; return { write: (s) => lines.push(s), lines }; };
const STAGE = { claimId: 'C1', faultId: 'F1', stage: 'probe', i: 2, n: 3 };

describe('progressMode', () => {
  it('reports in plain lines when stderr is not a terminal — the case that used to print nothing at all', () => {
    expect(progressMode({ isTTY: false })).toBe('plain');
  });

  it('keeps the rewriting line for a human at a terminal', () => {
    expect(progressMode({ isTTY: true })).toBe('tty');
  });

  it('is silent for --quiet and --json, so a JSON document stays the only thing on stdout', () => {
    expect(progressMode({ isTTY: true, quiet: true })).toBe('none');
    expect(progressMode({ isTTY: false, json: true })).toBe('none');
  });

  it('lets an explicit --progress win over every inference, including --quiet', () => {
    expect(progressMode({ explicit: 'ndjson', isTTY: true })).toBe('ndjson');
    expect(progressMode({ explicit: 'plain', isTTY: true, quiet: true })).toBe('plain');
    expect(progressMode({ explicit: 'none', isTTY: true })).toBe('none');
    expect(progressMode({ explicit: 'auto', isTTY: false })).toBe('plain');
  });

  it('names the modes it accepts', () => {
    expect(isProgressMode('plain')).toBe(true);
    expect(isProgressMode('verbose')).toBe(false);
  });
});

describe('stageReporter', () => {
  it('is undefined for none, so the probe skips reporting entirely', () => {
    expect(stageReporter('none', () => {})).toBeUndefined();
  });

  it('plain appends one newline-terminated line per stage and never rewrites', () => {
    const c = capture();
    stageReporter('plain', c.write)(STAGE);
    expect(c.lines).toEqual(['  … C1/F1 probe 2/3\n']);
    expect(c.lines[0]).not.toContain('\r');
  });

  it('plain prints every run of an N-run phase, because that is the thing a reader of a long log wants', () => {
    const c = capture();
    const r = stageReporter('plain', c.write);
    for (const i of [1, 2, 3]) r({ ...STAGE, i });
    expect(c.lines).toHaveLength(3);
  });

  it('tty keeps the carriage return and erase so the line rewrites in place', () => {
    const c = capture();
    stageReporter('tty', c.write)(STAGE);
    expect(c.lines[0]).toBe('\r\x1b[K  … C1/F1 probe 2/3');
  });

  it('ndjson emits one parseable object per line, with the run and its total', () => {
    const c = capture();
    stageReporter('ndjson', c.write)(STAGE);
    expect(c.lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(c.lines[0])).toMatchObject({ event: 'stage', claim: 'C1', fault: 'F1', stage: 'probe', run: 2, of: 3 });
  });
});

describe('clearStageLine', () => {
  it('clears only for tty; every other mode is already on its own line', () => {
    expect(clearStageLine('tty')).toBe('\r\x1b[K');
    expect(clearStageLine('plain')).toBe('');
    expect(clearStageLine('ndjson')).toBe('');
  });
});

describe('recordEvent', () => {
  const rec = { claim: { id: 'C1', severity: 'high' }, subject: { id: 'F1', file: 'src/x.mjs' }, verdict: 'survived' };

  it('is one parseable line carrying the verdict as it lands', () => {
    const e = JSON.parse(recordEvent(rec));
    expect(e).toMatchObject({ event: 'verdict', claim: 'C1', fault: 'F1', verdict: 'survived', severity: 'high', file: 'src/x.mjs' });
    expect(e.reused).toBeUndefined();
  });

  it('marks a reused verdict, so a watcher does not read it as work just done', () => {
    expect(JSON.parse(recordEvent({ ...rec, reusedFrom: 'run-1' })).reused).toBe(true);
  });
});

describe('progressStream', () => {
  it('is stderr, never stdout — a progress line on stdout does not degrade --json output, it destroys it', () => {
    const streams = { stdout: 'OUT', stderr: 'ERR' };
    expect(progressStream(streams)).toBe('ERR');
    expect(progressStream(streams)).not.toBe(streams.stdout);
  });
});
