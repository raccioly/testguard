// Documents the two reading rates with a local helper; does not touch src/.
const minutes = (count, perMinute) => (count === 0 ? 0 : Math.max(1, Math.ceil(count / perMinute)));

describe('reading rates (documentation)', () => {
  test('skimmer reads 400 words per minute', () => {
    expect(minutes(400, 400)).toBe(1);
    expect(minutes(401, 400)).toBe(2);
  });

  test('careful reads 200 words per minute', () => {
    expect(minutes(200, 200)).toBe(1);
    expect(minutes(201, 200)).toBe(2);
  });

  test('zero words take zero minutes', () => {
    expect(minutes(0, 200)).toBe(0);
  });
});
