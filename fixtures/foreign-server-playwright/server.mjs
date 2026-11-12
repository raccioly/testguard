// The system under test: a tiny server whose response depends on the source file under fault.
import { createServer } from 'node:http';
import { greeting } from './src/greeting.mjs';

createServer((req, res) => res.end(greeting)).listen(Number(process.env.TESTGUARD_FIXTURE_PORT), '127.0.0.1');
