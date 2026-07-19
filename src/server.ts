import 'dotenv/config';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { WebSocket, WebSocketServer } from 'ws';

type JsonRecord = Record<string, unknown>;

type Participant = {
  id: string;
  displayName: string;
  roomId: string;
  socket: WebSocket;
  isAlive: boolean;
  rateWindowStartedAt: number;
  messagesInWindow: number;
};

type WhiteboardClient = {
  id: string;
  roomId: string;
  displayName: string;
  socket: WebSocket;
  rateWindowStartedAt: number;
  messagesInWindow: number;
};

type WhiteboardRoom = {
  open: boolean;
  elements: Map<string, JsonRecord>;
  clients: Map<string, WhiteboardClient>;
};

const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: readPositiveInteger('PORT', 8787),
  allowedOrigins: csv(process.env.ALLOWED_ORIGINS),
  stunUrls: csv(process.env.STUN_URLS),
  turnUrls: csv(process.env.TURN_URLS),
  turnSharedSecret: process.env.TURN_SHARED_SECRET ?? '',
  turnCredentialTtlSeconds: readPositiveInteger('TURN_CREDENTIAL_TTL_SECONDS', 3600),
  maxRoomParticipants: Math.min(2, readPositiveInteger('MAX_ROOM_PARTICIPANTS', 2)),
  maxMessageBytes: readPositiveInteger('MAX_MESSAGE_BYTES', 65_536),
  maxMessagesPerWindow: readPositiveInteger('MAX_MESSAGES_PER_WINDOW', 120),
  rateLimitWindowMs: readPositiveInteger('RATE_LIMIT_WINDOW_MS', 10_000),
  livekitApiUrl: process.env.LIVEKIT_API_URL ?? '',
  livekitWsUrl: process.env.LIVEKIT_WS_URL ?? '',
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  livekitTokenTtlSeconds: readPositiveInteger('LIVEKIT_TOKEN_TTL_SECONDS', 3_600),
  livekitMaxParticipants: Math.min(10, readPositiveInteger('LIVEKIT_MAX_PARTICIPANTS', 10)),
};

const livekitConfigured = Boolean(
  config.livekitApiUrl && config.livekitWsUrl && config.livekitApiKey && config.livekitApiSecret,
);
const livekitRooms = livekitConfigured
  ? new RoomServiceClient(config.livekitApiUrl, config.livekitApiKey, config.livekitApiSecret)
  : null;

const rooms = new Map<string, Map<string, Participant>>();
const sockets = new Map<WebSocket, Participant>();
const whiteboardRooms = new Map<string, WhiteboardRoom>();
const whiteboardClients = new Map<WebSocket, WhiteboardClient>();

function readPositiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function csv(value: string | undefined) {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function send(socket: WebSocket, message: JsonRecord) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function json(response: ServerResponse, statusCode: number, body: JsonRecord, origin?: string) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(origin ? corsHeaders(origin) : {}),
  });
  response.end(JSON.stringify(body));
}

function originIsAllowed(origin: string | undefined) {
  if (!origin) return true;
  return config.allowedOrigins.length === 0
    ? config.nodeEnv !== 'production'
    : config.allowedOrigins.includes(origin);
}

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16_384) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_BODY');
  return parsed as JsonRecord;
}

async function issueLivekitToken(request: IncomingMessage, response: ServerResponse, origin?: string) {
  if (!livekitRooms) {
    return json(response, 503, { error: 'SFU_NOT_CONFIGURED' }, origin);
  }

  try {
    const body = await readJsonBody(request);
    const roomId = sanitizeRoomId(body.roomId);
    const displayName = sanitizeDisplayName(body.displayName);
    if (!roomId || !displayName) return json(response, 400, { error: 'INVALID_JOIN' }, origin);

    await livekitRooms.createRoom({
      name: roomId,
      emptyTimeout: 300,
      departureTimeout: 60,
      maxParticipants: config.livekitMaxParticipants,
      metadata: JSON.stringify({ platform: 'Helios Platform', capacity: config.livekitMaxParticipants }),
    });

    const identity = randomUUID();
    const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
      identity,
      name: displayName,
      ttl: config.livekitTokenTtlSeconds,
      metadata: JSON.stringify({ platform: 'Helios Platform' }),
    });
    token.addGrant({
      room: roomId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return json(response, 200, {
      token: await token.toJwt(),
      serverUrl: config.livekitWsUrl,
      roomId,
      participantIdentity: identity,
      maxParticipants: config.livekitMaxParticipants,
    }, origin);
  } catch (error) {
    console.error('[helios-conferences] LiveKit token error', error);
    return json(response, 500, { error: 'TOKEN_ISSUE_FAILED' }, origin);
  }
}

function makeIceServers() {
  const iceServers: Array<{ urls: string[]; username?: string; credential?: string }> = [];
  if (config.stunUrls.length) iceServers.push({ urls: config.stunUrls });

  if (config.turnUrls.length && config.turnSharedSecret) {
    const expiresAt = Math.floor(Date.now() / 1000) + config.turnCredentialTtlSeconds;
    const username = `${expiresAt}:${randomBytes(12).toString('hex')}`;
    const credential = createHmac('sha1', config.turnSharedSecret).update(username).digest('base64');
    iceServers.push({ urls: config.turnUrls, username, credential });
  }

  return iceServers;
}

function sanitizeRoomId(value: unknown) {
  if (typeof value !== 'string') return null;
  const roomId = value.trim();
  return /^[A-Za-z0-9_-]{3,100}$/.test(roomId) ? roomId : null;
}

function sanitizeDisplayName(value: unknown) {
  if (typeof value !== 'string') return null;
  const displayName = value.trim().replace(/\s+/g, ' ');
  return displayName.length >= 2 && displayName.length <= 60 ? displayName : null;
}

function parseMessage(raw: Buffer | ArrayBuffer | Buffer[]) {
  const byteLength = Array.isArray(raw)
    ? raw.reduce((total, item) => total + item.byteLength, 0)
    : raw.byteLength;
  if (byteLength > config.maxMessageBytes) throw new Error('MESSAGE_TOO_LARGE');
  const text = Array.isArray(raw)
    ? Buffer.concat(raw).toString('utf8')
    : raw instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(raw)).toString('utf8')
      : raw.toString('utf8');
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_MESSAGE');
  return parsed as JsonRecord;
}

function consumeRateLimit(participant: { rateWindowStartedAt: number; messagesInWindow: number }) {
  const now = Date.now();
  if (now - participant.rateWindowStartedAt >= config.rateLimitWindowMs) {
    participant.rateWindowStartedAt = now;
    participant.messagesInWindow = 0;
  }
  participant.messagesInWindow += 1;
  return participant.messagesInWindow <= config.maxMessagesPerWindow;
}

function broadcast(roomId: string, message: JsonRecord, exceptId?: string) {
  for (const participant of rooms.get(roomId)?.values() ?? []) {
    if (participant.id !== exceptId) send(participant.socket, message);
  }
}

function leaveRoom(socket: WebSocket) {
  const participant = sockets.get(socket);
  if (!participant) return;
  sockets.delete(socket);
  const room = rooms.get(participant.roomId);
  room?.delete(participant.id);
  broadcast(participant.roomId, { type: 'peer-left', participantId: participant.id });
  if (room?.size === 0) rooms.delete(participant.roomId);
}

function joinRoom(socket: WebSocket, message: JsonRecord) {
  if (sockets.has(socket)) {
    send(socket, { type: 'error', code: 'ALREADY_JOINED', message: 'La conexión ya pertenece a una sala.' });
    return;
  }

  const roomId = sanitizeRoomId(message.roomId);
  const displayName = sanitizeDisplayName(message.displayName);
  if (!roomId || !displayName) {
    send(socket, { type: 'error', code: 'INVALID_JOIN', message: 'Sala o nombre inválido.' });
    return;
  }

  const room = rooms.get(roomId) ?? new Map<string, Participant>();
  if (room.size >= config.maxRoomParticipants) {
    send(socket, { type: 'error', code: 'ROOM_FULL', message: 'La sala ya tiene dos participantes.' });
    return;
  }

  const participant: Participant = {
    id: randomUUID(),
    displayName,
    roomId,
    socket,
    isAlive: true,
    rateWindowStartedAt: Date.now(),
    messagesInWindow: 0,
  };
  const existingParticipants = [...room.values()].map(item => ({ id: item.id, displayName: item.displayName }));
  room.set(participant.id, participant);
  rooms.set(roomId, room);
  sockets.set(socket, participant);

  send(socket, {
    type: 'joined',
    participantId: participant.id,
    roomId,
    participants: existingParticipants,
  });
  broadcast(roomId, {
    type: 'peer-joined',
    participant: { id: participant.id, displayName: participant.displayName },
  }, participant.id);
}

function relay(participant: Participant, message: JsonRecord) {
  if (typeof message.targetId !== 'string' || !message.payload || typeof message.payload !== 'object') return;
  const target = rooms.get(participant.roomId)?.get(message.targetId);
  if (!target) return;
  send(target.socket, { type: 'signal', fromId: participant.id, payload: message.payload });
}

function relayMediaState(participant: Participant, message: JsonRecord) {
  const cameraEnabled = typeof message.cameraEnabled === 'boolean' ? message.cameraEnabled : true;
  const microphoneEnabled = typeof message.microphoneEnabled === 'boolean' ? message.microphoneEnabled : true;
  const screenSharing = typeof message.screenSharing === 'boolean' ? message.screenSharing : false;
  broadcast(participant.roomId, {
    type: 'media-state',
    fromId: participant.id,
    cameraEnabled,
    microphoneEnabled,
    screenSharing,
  }, participant.id);
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const origin = request.headers.origin;
  if (!originIsAllowed(origin)) return json(response, 403, { error: 'ORIGIN_NOT_ALLOWED' });
  if (request.method === 'OPTIONS' && origin) {
    response.writeHead(204, corsHeaders(origin));
    return response.end();
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, {
      status: 'ok',
      rooms: rooms.size,
      participants: sockets.size,
      timestamp: new Date().toISOString(),
    }, origin);
  }
  if (request.method === 'GET' && url.pathname === '/api/ice-servers') {
    return json(response, 200, { iceServers: makeIceServers() }, origin);
  }
  if (request.method === 'POST' && url.pathname === '/api/livekit/token') {
    return issueLivekitToken(request, response, origin);
  }
  return json(response, 404, { error: 'NOT_FOUND' }, origin);
});

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
const whiteboardWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!originIsAllowed(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  if (url.pathname === '/whiteboard') {
    const roomId = sanitizeRoomId(url.searchParams.get('roomId'));
    const displayName = sanitizeDisplayName(url.searchParams.get('displayName'));
    if (!roomId || !displayName) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    return whiteboardWebSocketServer.handleUpgrade(request, socket, head, ws => whiteboardWebSocketServer.emit('connection', ws, request));
  }
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  webSocketServer.handleUpgrade(request, socket, head, ws => webSocketServer.emit('connection', ws, request));
});

function sendWhiteboard(client: WhiteboardClient, message: JsonRecord) {
  send(client.socket, message);
}

function broadcastWhiteboard(room: WhiteboardRoom, message: JsonRecord, exceptId?: string) {
  for (const client of room.clients.values()) {
    if (client.id !== exceptId) sendWhiteboard(client, message);
  }
}

function leaveWhiteboard(socket: WebSocket) {
  const client = whiteboardClients.get(socket);
  if (!client) return;
  whiteboardClients.delete(socket);
  const room = whiteboardRooms.get(client.roomId);
  room?.clients.delete(client.id);
  if (!room) return;
  broadcastWhiteboard(room, { type: 'cursor-left', identity: client.id }, client.id);
  if (room.clients.size === 0) whiteboardRooms.delete(client.roomId);
}

whiteboardWebSocketServer.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const roomId = sanitizeRoomId(url.searchParams.get('roomId'))!;
  const displayName = sanitizeDisplayName(url.searchParams.get('displayName'))!;
  const room = whiteboardRooms.get(roomId) ?? { open: false, elements: new Map<string, JsonRecord>(), clients: new Map<string, WhiteboardClient>() };
  if (room.clients.size >= 10) return socket.close(1008, 'Whiteboard room full');

  const client: WhiteboardClient = {
    id: randomUUID(), roomId, displayName, socket,
    rateWindowStartedAt: Date.now(), messagesInWindow: 0,
  };
  room.clients.set(client.id, client);
  whiteboardRooms.set(roomId, room);
  whiteboardClients.set(socket, client);

  sendWhiteboard(client, { type: 'whiteboard-mode', open: room.open });
  for (const element of room.elements.values()) sendWhiteboard(client, { type: 'upsert', element });

  socket.on('message', raw => {
    try {
      if (!consumeRateLimit(client)) return socket.close(1008, 'Rate limit exceeded');
      const message = parseMessage(raw);
      if (message.type === 'whiteboard-mode' && typeof message.open === 'boolean') {
        room.open = message.open;
      } else if (message.type === 'upsert' && message.element && typeof message.element === 'object' && !Array.isArray(message.element)) {
        const element = message.element as JsonRecord;
        if (typeof element.id !== 'string' || element.id.length > 100) return;
        room.elements.set(element.id, element);
      } else if (message.type === 'delete' && typeof message.id === 'string') {
        room.elements.delete(message.id);
      } else if (message.type === 'clear') {
        room.elements.clear();
      } else if (message.type !== 'cursor') {
        return;
      }
      broadcastWhiteboard(room, { ...message, senderId: client.id, senderName: client.displayName }, client.id);
    } catch {
      socket.close(1008, 'Invalid whiteboard message');
    }
  });
  socket.on('close', () => leaveWhiteboard(socket));
  socket.on('error', () => leaveWhiteboard(socket));
});

webSocketServer.on('connection', socket => {
  socket.on('pong', () => {
    const participant = sockets.get(socket);
    if (participant) participant.isAlive = true;
  });

  socket.on('message', raw => {
    try {
      const participant = sockets.get(socket);
      if (participant && !consumeRateLimit(participant)) {
        send(socket, { type: 'error', code: 'RATE_LIMITED', message: 'Demasiados mensajes.' });
        return socket.close(1008, 'Rate limit exceeded');
      }
      const message = parseMessage(raw);
      if (message.type === 'join') return joinRoom(socket, message);
      if (!participant) return send(socket, { type: 'error', code: 'NOT_JOINED', message: 'Primero debes entrar a una sala.' });
      if (message.type === 'signal') return relay(participant, message);
      if (message.type === 'media-state') return relayMediaState(participant, message);
      if (message.type === 'leave') return socket.close(1000, 'Participant left');
      send(socket, { type: 'error', code: 'UNKNOWN_MESSAGE', message: 'Tipo de mensaje desconocido.' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INVALID_MESSAGE';
      send(socket, { type: 'error', code, message: 'No se pudo procesar el mensaje.' });
    }
  });

  socket.on('close', () => leaveRoom(socket));
  socket.on('error', () => leaveRoom(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of webSocketServer.clients) {
    const participant = sockets.get(socket);
    if (participant && !participant.isAlive) {
      leaveRoom(socket);
      socket.terminate();
      continue;
    }
    if (participant) participant.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref();

function shutdown(signal: string) {
  console.log(`[helios-conferences] ${signal}: closing ${sockets.size} connections`);
  clearInterval(heartbeat);
  for (const socket of webSocketServer.clients) socket.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  console.log(`[helios-conferences] listening on http://${config.host}:${config.port}`);
  if (config.nodeEnv === 'production' && config.allowedOrigins.length === 0) {
    console.warn('[helios-conferences] production requires ALLOWED_ORIGINS; browser requests will be rejected.');
  }
});
