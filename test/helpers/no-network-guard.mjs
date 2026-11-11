// Preloaded with `node --import` into TestGuard and every Node process it
// starts (through NODE_OPTIONS). Any attempt to open a TCP or UDP socket, or to
// resolve a name, is appended to the file named by TESTGUARD_NETWORK_LOG and
// then refused. A local socket (`path`, an IPC pipe) is not network and passes.
// The acceptance tests assert the log is empty: the probe path opens no socket.
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';

const log = process.env.TESTGUARD_NETWORK_LOG;
const refuse = (kind, detail) => {
  if (log) appendFileSync(log, `${process.pid} ${kind} ${detail}\n`);
  throw new Error(`network is not available: ${kind} ${detail}`);
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const local = (typeof options === 'object' && options !== null && options.path) || (typeof first === 'string' && Number.isNaN(Number(first)));
  if (!local) refuse('connect', JSON.stringify(typeof options === 'object' ? { host: options?.host, port: options?.port } : options));
  return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function guarded(...args) {
  const first = args[0];
  const local = (typeof first === 'object' && first !== null && first.path) || (typeof first === 'string' && Number.isNaN(Number(first)));
  if (!local) refuse('listen', JSON.stringify(typeof first === 'object' ? { host: first?.host, port: first?.port } : first));
  return listen.apply(this, args);
};
for (const method of ['bind', 'send', 'connect']) {
  const original = dgram.Socket.prototype[method];
  dgram.Socket.prototype[method] = function guarded(...args) { refuse(`udp-${method}`, ''); return original.apply(this, args); };
}
for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const original = dns[method];
  dns[method] = function guarded(host, ...rest) { refuse(`dns-${method}`, String(host)); return original.call(this, host, ...rest); };
}
