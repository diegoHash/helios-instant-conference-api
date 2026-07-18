import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';

const port = 18787;
const origin = 'http://localhost:5173';
const baseUrl = `http://127.0.0.1:${port}`;
let server;

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await delay(100);
  }
  throw new Error('Test server did not start');
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 2_000);
    const handler = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== expectedType) return;
      clearTimeout(timeout);
      socket.off('message', handler);
      resolve(message);
    };
    socket.on('message', handler);
  });
}

test.before(async () => {
  server = spawn(process.execPath, ['dist/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      ALLOWED_ORIGINS: origin,
      STUN_URLS: 'stun:turn.example.test:3478',
      TURN_URLS: 'turn:turn.example.test:3478?transport=udp',
      TURN_SHARED_SECRET: 'test-secret-not-for-production',
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => {
  server?.kill('SIGTERM');
});

test('health and temporary TURN credentials are available', async () => {
  const health = await fetch(`${baseUrl}/health`).then(response => response.json());
  assert.equal(health.status, 'ok');

  const configuration = await fetch(`${baseUrl}/api/ice-servers`, { headers: { Origin: origin } }).then(response => response.json());
  assert.equal(configuration.iceServers.length, 2);
  assert.match(configuration.iceServers[1].username, /^\d+:/);
  assert.ok(configuration.iceServers[1].credential);
});

test('a room accepts two participants, relays signals, and rejects a third', async t => {
  const first = await openSocket();
  const second = await openSocket();
  const third = await openSocket();
  t.after(() => [first, second, third].forEach(socket => socket.close()));

  const firstJoinResponse = nextMessage(first, 'joined');
  first.send(JSON.stringify({ type: 'join', roomId: 'test-room', displayName: 'Primero' }));
  const firstJoined = await firstJoinResponse;

  const firstSeesSecond = nextMessage(first, 'peer-joined');
  const secondJoinResponse = nextMessage(second, 'joined');
  second.send(JSON.stringify({ type: 'join', roomId: 'test-room', displayName: 'Segundo' }));
  const secondJoined = await secondJoinResponse;
  await firstSeesSecond;

  assert.equal(firstJoined.participants.length, 0);
  assert.equal(secondJoined.participants.length, 1);

  const relayedSignal = nextMessage(second, 'signal');
  first.send(JSON.stringify({
    type: 'signal',
    targetId: secondJoined.participantId,
    payload: { description: { type: 'offer', sdp: 'test-sdp' } },
  }));
  const signal = await relayedSignal;
  assert.equal(signal.fromId, firstJoined.participantId);
  assert.equal(signal.payload.description.sdp, 'test-sdp');

  const thirdJoinResponse = nextMessage(third, 'error');
  third.send(JSON.stringify({ type: 'join', roomId: 'test-room', displayName: 'Tercero' }));
  const rejected = await thirdJoinResponse;
  assert.equal(rejected.code, 'ROOM_FULL');
});
