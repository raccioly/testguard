/** A refusal to start: the run cannot be made safely, so nothing is measured. The CLI reports it as exit 2. */
export class PreconditionError extends Error {}
