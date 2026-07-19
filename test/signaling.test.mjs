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
  for (let attempt = 0; attempt < 120; attempt += 1) {
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

function openWhiteboardSocket(roomId, displayName, expectedTypes = []) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ roomId, displayName });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/whiteboard?${params}`, { origin });
    const messages = expectedTypes.map(type => nextMessage(socket, type));
    socket.once('open', () => resolve({ socket, messages }));
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

function nextMatchingMessage(socket, predicate, description) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 3_000);
    const handler = raw => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
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

test('LiveKit token endpoint stays unavailable until the SFU is configured', async () => {
  const response = await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: 'test-room', displayName: 'Participante' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'SFU_NOT_CONFIGURED');
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

test('whiteboard state is shared with late participants and removed when the room empties', async t => {
  const { socket: first, messages: [firstMode] } = await openWhiteboardSocket('board-room', 'Primero', ['whiteboard-mode']);
  t.after(() => first.close());
  assert.equal((await firstMode).open, false);

  first.send(JSON.stringify({ type: 'whiteboard-mode', open: true }));
  first.send(JSON.stringify({ type: 'upsert', element: { id: 'stroke-1', kind: 'path', points: [[1, 2], [3, 4]] } }));

  const { socket: second, messages: [secondMode, secondUpsert] } = await openWhiteboardSocket(
    'board-room', 'Segundo', ['whiteboard-mode', 'upsert'],
  );
  t.after(() => second.close());
  assert.equal((await secondMode).open, true);
  const upsert = await secondUpsert;
  assert.equal(upsert.element.id, 'stroke-1');

  const strokeStart = nextMessage(second, 'stroke-start');
  const strokePoints = nextMessage(second, 'stroke-points');
  const strokeEnd = nextMessage(second, 'stroke-end');
  first.send(JSON.stringify({ type: 'stroke-start', seq: 0, element: { id: 'stroke-live', type: 'pencil', points: [[5, 5]] } }));
  first.send(JSON.stringify({ type: 'stroke-points', id: 'stroke-live', seq: 2, points: [[6, 6], [7, 7]] }));
  first.send(JSON.stringify({ type: 'stroke-end', seq: 3, element: { id: 'stroke-live', type: 'pencil', points: [[5, 5], [6, 6], [7, 7]] } }));
  assert.equal((await strokeStart).element.id, 'stroke-live');
  assert.equal((await strokePoints).points.length, 2);
  assert.equal((await strokeEnd).element.points.length, 3);

  const finalCursor = nextMatchingMessage(second, message => message.type === 'cursor' && message.x === 299, 'last cursor in burst');
  for (let index = 0; index < 300; index += 1) {
    first.send(JSON.stringify({ type: 'cursor', x: index, y: index }));
  }
  assert.equal((await finalCursor).x, 299);
  assert.equal(first.readyState, WebSocket.OPEN);

  first.close();
  second.close();
  await Promise.all([
    new Promise(resolve => first.once('close', resolve)),
    new Promise(resolve => second.once('close', resolve)),
  ]);
  await delay(50);

  const { socket: third, messages: [thirdMode] } = await openWhiteboardSocket('board-room', 'Tercero', ['whiteboard-mode']);
  t.after(() => third.close());
  assert.equal((await thirdMode).open, false);
});
