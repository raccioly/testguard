// A settings row with an ON/OFF toggle, rendered to an HTML string.
// Every claim in ../testguard.claims.json is about this file.

/** Render the "Send a greeting" row. The checkbox is the toggle; `onchange` is its handler. */
export function renderToggle({ on = false, handler = 'saveGreeting' } = {}) {
  const lines = [
    '<label class="toggle">',
    `  <input type="checkbox" data-testid="greeting-toggle"${on ? ' checked' : ''}`,
    `    onchange="${handler}(this.checked)">`,
    '  Send a greeting',
    '</label>',
  ];
  const html = lines.join('\n');
  return html;
}
