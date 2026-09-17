const { mask, redact, compileRules } = require('../src/redact');

const SECRET = 'FIXTURE_SECRET_7731';
const RULES = [{ id: 'r1', pattern: 'FIXTURE_SECRET_\\d+' }];
const CTX = { scope: 'g1' };

describe('redaction', () => {
  it('masks the secret out of the returned text', () => {
    const out = mask(`hello ${SECRET} bye`, RULES);
    expect(out).not.toContain(SECRET);
    expect(out).toBe('hello ******************* bye');
  });

  it('skips a rule whose pattern is invalid without throwing', () => {
    const rules = [{ id: 'bad', pattern: '(' }, ...RULES];
    expect(() => compileRules(rules)).not.toThrow();
    expect(compileRules(rules)).toHaveLength(1);
    expect(mask(SECRET, rules)).not.toContain(SECRET);
  });

  it('writes an audit row when something was masked', async () => {
    const store = { writeAudit: jest.fn().mockResolvedValue(undefined) };
    await redact(`hello ${SECRET}`, RULES, CTX, store);
    // THE BLIND SPOT: objectContaining ignores unlisted keys, and `content` is not listed.
    expect(store.writeAudit).toHaveBeenCalledTimes(1);
    expect(store.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }));
  });

  it('does not write an audit row when nothing matched', async () => {
    const store = { writeAudit: jest.fn() };
    const out = await redact('nothing here', RULES, CTX, store);
    expect(out).toBe('nothing here');
    expect(store.writeAudit).not.toHaveBeenCalled();
  });
});
