/** Token-aware CLI admission; defaults are not explicit user options. */
export function draftAppendRequest({ command, values, suppliedOptions = [], files = [] }) {
  if (values.into === undefined) return null;
  if (command !== 'scaffold') throw new Error('--into is only valid on scaffold');
  const allowed = new Set(['into', 'claim', 'json', 'help', 'version']);
  const conflict = suppliedOptions.find(name => !allowed.has(name));
  if (conflict || values.out !== undefined || values.claims !== undefined) throw new Error(`--into cannot use --${conflict || (values.out !== undefined ? 'out' : 'claims')}`);
  if (!Array.isArray(values.into) || values.into.length !== 1 || !values.into[0]?.trim() || values.into[0] !== values.into[0].trim()) throw new Error('--into requires exactly one existing draft path');
  if (!Array.isArray(values.claim) || values.claim.length !== 1 || !values.claim[0]?.trim() || values.claim[0].includes(',') || values.claim[0] !== values.claim[0].trim()) throw new Error('--into requires exactly one --claim <existing-ID>');
  if (!files.length) throw new Error('--into requires at least one source file');
  return { draftPath: values.into[0], claimId: values.claim[0], files };
}

/** Internal read-only input selection; public CLI exposure requires its report contract. */
export function intentInputRequest({ command, values, suppliedOptions = [], files = [] }) {
  const modes = ['from-document', 'from-fix'].filter(name => values[name] !== undefined);
  if (!modes.length) return null;
  if ('scaffold' !== command) throw new Error('intent input is only valid on scaffold');
  if (modes.length !== 1) throw new Error('select exactly one input mode');
  const allowed = new Set(['from-document', 'from-fix', 'json', 'help', 'version']);
  const conflict = suppliedOptions.find(name => !allowed.has(name)) ?? ['into', 'claim', 'claims', 'out'].find(name => values[name] !== undefined);
  if (conflict) throw new Error(`intent input cannot use --${conflict}`);
  if (files.length) throw new Error('intent input cannot use positional source files');
  const mode = modes[0], selectors = values[mode];
  if (!Array.isArray(selectors) || selectors.length !== 1 || typeof selectors[0] !== 'string' || !selectors[0] || selectors[0] !== selectors[0].trim() || selectors[0].includes('\0')) throw new Error('intent input requires exactly one nonempty trimmed selector');
  const selector = selectors[0];
  if (Buffer.byteLength(selector) > 4096) throw new Error('intent input selector-byte-limit');
  if (mode === 'from-fix' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(selector)) throw new Error('intent input requires full-object-id');
  return Object.freeze(mode === 'from-document' ? { kind: 'document', file: selector } : { kind: 'fix', commit: selector });
}
