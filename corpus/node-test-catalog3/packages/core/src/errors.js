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

export const InvalidIsbnError = define('InvalidIsbnError');
export const InvalidTitleError = define('InvalidTitleError');
export const InvalidAuthorError = define('InvalidAuthorError');
