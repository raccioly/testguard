'use strict';

function define(name) {
  const cls = class extends Error {
    constructor(message) {
      super(message);
      this.name = name;
    }
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

module.exports = {
  MissingValueError: define('MissingValueError'),
  TemplateSyntaxError: define('TemplateSyntaxError'),
  EmptySlugError: define('EmptySlugError'),
  InvalidLimitError: define('InvalidLimitError'),
  InvalidCountError: define('InvalidCountError'),
  UnknownReaderError: define('UnknownReaderError'),
  EmptyScheduleError: define('EmptyScheduleError'),
  InvalidDayError: define('InvalidDayError'),
  InvalidTimeError: define('InvalidTimeError'),
  UnknownRecipientError: define('UnknownRecipientError'),
};
