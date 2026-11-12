function define(name) {
  return class extends Error {
    constructor(message) {
      super(message);
      this.name = name;
    }
  };
}

export const InvalidAmount = define('InvalidAmount');
export const InvalidSplit = define('InvalidSplit');
export const UnknownSplitType = define('UnknownSplitType');
