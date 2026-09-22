import { describe, it, expect } from 'vitest';
import { selectFaults, scoreOf, priorFor, onWritePath, capFor, presentational, MEASURED_PRODUCTIVITY } from '../src/supply/select.mjs';

const f = (over = {}) => ({ id: 'S1', faultClass: 'statement-deleted', file: 'src/a.ts', line: 1, find: 'x = 1;', ...over });
const pair = (claimId, over) => ({ claim: { id: claimId }, fault: f(over) });

describe('priorFor — measured, and shrunk toward the prior when the sample is small', () => {
  it('a class nobody measured ranks between the best and worst measured one', () => {
    const unknown = priorFor('brand-new-shape');
    expect(unknown).toBeGreaterThan(priorFor('return-altered'));
    expect(unknown).toBeLessThan(priorFor('field-dropped'));
  });

  it('one observation of 100% does not become certainty', () => {
    // element-removed is 1/1 in the measured table. Reported at face value it
    // would outrank field-dropped (6/12) and dominate every sweep on a single
    // data point — the overconfidence this tool exists to refuse.
    expect(MEASURED_PRODUCTIVITY['element-removed']).toEqual({ p: 1, n: 1 });
    expect(priorFor('element-removed')).toBeLessThan(1);
    expect(priorFor('element-removed')).toBeLessThan(priorFor('field-dropped') + 0.15);
  });

  it('a larger sample moves further from the prior than a smaller one with the same rate', () => {
    const table = { big: { p: 0.9, n: 40 }, small: { p: 0.9, n: 1 } };
    expect(priorFor('big', table)).toBeGreaterThan(priorFor('small', table));
  });
});

describe('onWritePath — the persistence lines every measured survivor sat on', () => {
  it('a payload key of a write', () => {
    expect(onWritePath(f({ find: '      data: { user_id: recipientId },' }))).toBe(true);
    expect(onWritePath(f({ find: '  where: { id: invitation.id },' }))).toBe(true);
    expect(onWritePath(f({ find: '    select: { id: true },' }))).toBe(true);
  });

  it('the write call itself, across ORMs', () => {
    expect(onWritePath(f({ find: 'await prisma.user.update({ where, data });' }))).toBe(true);
    expect(onWritePath(f({ find: 'await tx.invitation.upsert({' }))).toBe(true);
    expect(onWritePath(f({ find: 'await knex("users").insert(row);' }))).toBe(true);
  });

  it('ordinary logic is not on the write path', () => {
    expect(onWritePath(f({ find: 'if (!session) return null;' }))).toBe(false);
    expect(onWritePath(f({ find: 'const total = a + b;' }))).toBe(false);
  });
});

describe('presentational — the arid class this tool actually has', () => {
  // Measured 2026-09-22 on a 14-file UI diff: 147 of 510 proposals, 29 of 30
  // probe slots, 7 of 10 survivors. Google's arid categories were under 1%.
  const el = (find) => f({ faultClass: 'element-removed', find });

  it('an icon is a self-closing PascalCase element with only sizing and styling props', () => {
    expect(presentational(el('        <X size={16} className="text-muted" />'))).toBe(true);
    expect(presentational(el('<ChevronLeft />'))).toBe(true);
    expect(presentational(el('<Search size={18} strokeWidth={1.5} aria-hidden="true" />'))).toBe(true);
  });

  it('a static wrapper is a layout or text tag with no expression and no handler', () => {
    expect(presentational(el('  <div className="flex items-center gap-2">'))).toBe(true);
    expect(presentational(el('<p className="note">All time</p>'))).toBe(true);
    expect(presentational(el('<h2 className="title">Taste Fingerprint</h2>'))).toBe(true);
    expect(presentational(el('<span />'))).toBe(true);
  });

  it('anything that renders data, reacts, or is addressed by a test is a real proposal', () => {
    expect(presentational(el('<p className="ts">{data.timestamp}</p>'))).toBe(false);
    expect(presentational(el('<div onClick={() => close()}>'))).toBe(false);
    expect(presentational(el('<span role="status">saved</span>'))).toBe(false);
    expect(presentational(el('<div data-testid="empty-state">'))).toBe(false);
    expect(presentational(el('<label htmlFor="email">Email</label>'))).toBe(false);
    expect(presentational(el('<img src="/logo.png" alt="Logo" />'))).toBe(false);
    expect(presentational(el('<HeatBadge level={venue.heat} />'))).toBe(false);
    expect(presentational(el('<Link href="/login">Sign in</Link>'))).toBe(false);
  });

  it('only ever applies to an element removal — a wrapper line under another class is not its business', () => {
    expect(presentational(f({ faultClass: 'handler-dropped', find: '<div className="row">' }))).toBe(false);
  });

  it('selectFaults sets them aside, returns them, and still counts them in the tally', () => {
    const r = selectFaults([
      pair('A', { id: 'S1', faultClass: 'element-removed', find: '<X size={16} />', line: 1 }),
      pair('A', { id: 'S2', faultClass: 'element-removed', find: '<HeatBadge level={x} />', line: 2 }),
      pair('A', { id: 'S3', faultClass: 'handler-dropped', find: 'onClick={save}', line: 3 }),
    ], { cap: 5 });
    expect(r.selected.map((c) => c.fault.id).sort()).toEqual(['S2', 'S3']);
    expect(r.deferred).toEqual([]);
    expect(r.presentational.map((c) => c.fault.id)).toEqual(['S1']);
    // The partition is complete: nothing was dropped without a name.
    expect(r.selected.length + r.deferred.length + r.presentational.length).toBe(3);
    expect(r.byClass['element-removed'].proposed).toBe(2);
    expect(r.byClass['element-removed'].selected).toBe(1);
  });
});

describe('selectFaults — a cap that hides work is a coverage claim nobody made', () => {
  const candidates = [
    pair('C1', { id: 'S1', faultClass: 'return-altered', file: 'src/a.ts', line: 3 }),
    pair('C1', { id: 'S2', faultClass: 'field-dropped', file: 'src/a.ts', line: 9, find: '  data: { email },' }),
    pair('C2', { id: 'S1', faultClass: 'argument-swapped', file: 'src/b.ts', line: 2 }),
    pair('C2', { id: 'S2', faultClass: 'field-dropped', file: 'src/b.ts', line: 4 }),
  ];

  it('everything past the cap is returned, never dropped', () => {
    const r = selectFaults(candidates, { cap: 2 });
    expect(r.selected).toHaveLength(2);
    expect(r.deferred).toHaveLength(2);
    expect([...r.selected, ...r.deferred]).toHaveLength(candidates.length);
  });

  it('a write-path field drop outranks the same class off the path, and both outrank an unproductive class', () => {
    const r = selectFaults(candidates, { cap: 4 });
    const order = r.selected.map((x) => x.fault.faultClass);
    expect(r.selected[0].fault.find).toBe('  data: { email },');
    expect(order.indexOf('field-dropped')).toBeLessThan(order.indexOf('argument-swapped'));
    expect(order.indexOf('field-dropped')).toBeLessThan(order.indexOf('return-altered'));
  });

  it('a bigger sample of a low rate outranks DOWNWARD past a tiny sample of zero', () => {
    // argument-swapped is 1/11 and return-altered 0/4. Shrunk, argument-swapped
    // lands BELOW return-altered: eleven observations of 9% is stronger
    // evidence of unproductivity than four observations of 0%. Asserted because
    // it is the counter-intuitive half of the estimator and the first version
    // of this test assumed the opposite.
    expect(priorFor('argument-swapped')).toBeLessThan(priorFor('return-altered'));
    expect(selectFaults(candidates, { cap: 4 }).selected.at(-1).fault.faultClass).toBe('argument-swapped');
  });

  it('the write-path bonus cannot overtake a measured class outright', () => {
    // Otherwise every `data:` line in the repository would precede every
    // element-removed, and the ordering would stop being about productivity.
    const best = priorFor('element-removed');
    expect(scoreOf(f({ faultClass: 'return-altered', find: '  data: { x },' }))).toBeLessThan(best);
  });

  it('is deterministic to the last tie', () => {
    const a = selectFaults(candidates, { cap: 3 });
    const b = selectFaults([...candidates].reverse(), { cap: 3 });
    expect(a.selected.map((x) => `${x.claim.id}/${x.fault.id}`)).toEqual(b.selected.map((x) => `${x.claim.id}/${x.fault.id}`));
  });

  it('defaults the cap to 7 x files, as Google surfaces per change', () => {
    expect(capFor(1)).toBe(7);
    expect(capFor(4)).toBe(28);
    expect(selectFaults(candidates).cap).toBe(capFor(2));
  });

  it('spreads the cap across files instead of letting one file take it', () => {
    // A 14-file sweep spent all six slots on one page component and reported
    // nothing about the other twelve, which is indistinguishable from those
    // twelve being clean. The cap is expressed per file; this is what that means.
    const many = [
      ...[1, 2, 3, 4].map((n) => pair('BIG', { id: `S${n}`, faultClass: 'element-removed', file: 'src/big.tsx', line: n })),
      pair('SMALL', { id: 'S1', faultClass: 'statement-deleted', file: 'src/small.ts', line: 1 }),
    ];
    const files = selectFaults(many, { cap: 2 }).selected.map((x) => x.fault.file);
    expect(new Set(files)).toEqual(new Set(['src/big.tsx', 'src/small.ts']));
  });

  it('a file with more candidates still gets more slots once every file has one', () => {
    const many = [
      ...[1, 2, 3].map((n) => pair('BIG', { id: `S${n}`, faultClass: 'field-dropped', file: 'src/big.ts', line: n })),
      pair('SMALL', { id: 'S1', faultClass: 'field-dropped', file: 'src/small.ts', line: 1 }),
    ];
    const files = selectFaults(many, { cap: 4 }).selected.map((x) => x.fault.file);
    expect(files.filter((f) => f === 'src/big.ts')).toHaveLength(3);
    expect(files.filter((f) => f === 'src/small.ts')).toHaveLength(1);
  });

  it('tallies every class it saw, not only the ones it took', () => {
    const r = selectFaults(candidates, { cap: 1 });
    expect(r.byClass['return-altered']).toEqual({ proposed: 1, selected: 0, writePath: 0 });
    expect(r.byClass['field-dropped'].proposed).toBe(2);
    expect(r.byClass['field-dropped'].writePath).toBe(1);
  });
});
