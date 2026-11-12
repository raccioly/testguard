'use strict';

const { UnknownRecipientError } = require('./errors');

function footer(recipient) {
  const kind = recipient && recipient.kind;
  if (kind === 'subscriber') {
    return `Thanks for reading, ${recipient.name}. Unsubscribe anytime.`;
  }
  if (kind === 'guest') {
    return 'Enjoying Quillbird? Subscribe at quillbird.example/join.';
  }
  throw new UnknownRecipientError(`unknown recipient kind: ${kind}`);
}

module.exports = { footer };
