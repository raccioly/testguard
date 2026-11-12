jest.mock('../src/footer');

const { footer } = require('../src/footer');

describe('footer (mocked)', () => {
  test('returns the stubbed value and is called with the recipient', () => {
    footer.mockReturnValue('stub');
    const recipient = { kind: 'subscriber', name: 'Ann' };
    expect(footer(recipient)).toBe('stub');
    expect(footer).toHaveBeenCalledWith(recipient);
  });
});
