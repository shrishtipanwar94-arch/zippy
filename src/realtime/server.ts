// The Socket.IO server: who may connect, and which rooms they land in.
//
// JWT VERIFIED ON THE HANDSHAKE, NOT AFTER CONNECT.
// `io.use(...)` runs during the handshake, before the connection is
// established and before any 'connection' handler fires. A bad token is
// rejected there and the socket never exists. The alternative — accept the
// socket, then check a token on the first message — leaves an authenticated-
// looking connection sitting in the server for however long the client takes
// to send it, and every handler downstream has to remember it might not be
// authenticated yet. Rejecting at the handshake means a live socket is an
// authenticated socket, always, with no second state to reason about.
//
// The token is read from `handshake.auth.token`, which Socket.IO sends in the
// connection payload rather than the URL — a query string ends up in proxy
// logs and browser history.

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'socket.io';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { runWithAuthContext } from '../auth/context.js';
import type { AuthContext } from '../auth/context.js';
import { TokenError, verifyAccessToken } from '../auth/tokens.js';
import { jobRoom, mayRequestJobRoom, standingRoomsFor } from './rooms.js';
import { setRealtimeServer } from './publish.js';
import { replayJobEvents } from './replay.js';
import { createRealtimeRedisConnection } from './redisConnection.js';

// Socket.IO's own type for per-socket state. One field: who this connection is.
type SocketData = { auth: AuthContext };

// What a client sends to subscribe. `lastEventSequence` is its cursor for this
// job — the highest sequence it has already applied. Omitted on a first
// subscribe, present on a resubscribe after a drop.
type SubscribeRequest = { jobId: string; lastEventSequence?: number };

type SubscribeAck = { ok: boolean };

function parseSubscribeRequest(raw: unknown): SubscribeRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const { jobId, lastEventSequence } = raw as Record<string, unknown>;
  if (typeof jobId !== 'string' || jobId.length === 0) return null;

  if (lastEventSequence === undefined) return { jobId };
  // Sequences start at 1, so 0 is the legitimate way to say "I have nothing
  // for this job, send me everything".
  if (!Number.isInteger(lastEventSequence) || (lastEventSequence as number) < 0) return null;

  return { jobId, lastEventSequence: lastEventSequence as number };
}

function tokenFrom(socket: Socket): string | null {
  const raw = socket.handshake.auth?.token;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

// Held so `closeRealtimeAdapter()` can disconnect them on shutdown. The
// adapter stops USING these connections when the Server closes, but does not
// disconnect them itself — left alone, they would be two open TCP sockets
// outliving the process they belonged to.
let adapterConnections: { pubClient: ReturnType<typeof createRealtimeRedisConnection>; subClient: ReturnType<typeof createRealtimeRedisConnection> } | null = null;

export async function closeRealtimeAdapter(): Promise<void> {
  if (!adapterConnections) return;
  adapterConnections.pubClient.disconnect();
  adapterConnections.subClient.disconnect();
  adapterConnections = null;
}

// Whether this process is refusing socket connections on purpose. A module
// flag rather than a database read per handshake: the chaos route flips it in
// the same process, and a demo control is not worth a query on every connect.
let liveUpdatesSuppressed = false;

// The server this process created, so the chaos route can reach it without
// index.ts having to thread the instance through app.ts. Same registry pattern
// as setRealtimeServer in publish.ts, for the same reason.
let currentServer: Server | null = null;

export function suppressLiveUpdates(suppressed: boolean): void {
  liveUpdatesSuppressed = suppressed;
  // Existing sockets are dropped too, or the switch would only affect people
  // who arrive after it — and the whole point is to watch a connected console
  // fall back to polling.
  if (suppressed && currentServer) currentServer.disconnectSockets(true);
}

export function createRealtimeServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
  });
  currentServer = io;

  // THE REDIS ADAPTER — what makes a room span more than one process.
  // Socket.IO's default adapter keeps room membership in the memory of the
  // ONE process running it: `io.to(room).emit()` can only reach a socket this
  // same `Server` accepted. That is fine with one web process and nothing
  // else ever publishing. It stops being fine the moment `publish.ts`'s
  // fallback Emitter (used by the worker process and the simulator CLI) needs
  // to reach a socket connected HERE — without this adapter that publish
  // would go out over Redis and nothing would be subscribed to hear it. The
  // adapter subscribes this process to the same channel the Emitter publishes
  // on and re-delivers into this `Server`'s own rooms; two ioredis
  // connections because a subscribing connection can do nothing else once it
  // subscribes (see redisConnection.ts).
  const pubClient = createRealtimeRedisConnection('adapter-pub');
  const subClient = createRealtimeRedisConnection('adapter-sub');
  adapterConnections = { pubClient, subClient };
  io.adapter(createAdapter(pubClient, subClient));

  // CHAOS FIRST, AUTH SECOND (Phase 17). When live updates are switched off,
  // the handshake is refused before anything else is checked, and the client's
  // own reconnect loop then falls back to polling — which is exactly what
  // happens when the fan-out really is unreachable. Simulating this by
  // silently dropping messages instead would leave a client that believes it
  // is connected and is quietly missing events: a worse failure than the one
  // being demonstrated, and an invisible one.
  io.use((socket, next) => {
    if (liveUpdatesSuppressed) {
      next(new Error('live_updates_unavailable'));
      return;
    }
    next();
  });

  io.use((socket, next) => {
    const token = tokenFrom(socket);
    if (!token) {
      next(new Error('missing_token'));
      return;
    }

    try {
      const claims = verifyAccessToken(token);
      (socket.data as SocketData).auth = {
        userId: claims.sub,
        role: claims.role,
        tenantId: claims.tenantId,
        crossTenant: claims.crossTenant,
        actorId: claims.actorId,
      };
      next();
    } catch (error) {
      // The client is told only that authentication failed — never whether the
      // token was malformed, expired or forged.
      if (error instanceof TokenError) {
        next(new Error('invalid_token'));
        return;
      }
      next(error as Error);
    }
  });

  io.on('connection', (socket) => {
    const auth = (socket.data as SocketData).auth;

    void joinStandingRooms(socket, auth);

    // A per-job subscription is a request, not a right. It is authorised
    // through the SCOPED Prisma client inside the caller's auth context, so
    // the tenant filter and the row-ownership rule from Phase 2 decide it —
    // the same two extensions that guard GET /jobs/:id. A driver asking for
    // someone else's job finds nothing and is refused, exactly as the HTTP
    // route would 404.
    socket.on('job:subscribe', (raw: unknown, ack?: (result: SubscribeAck) => void) => {
      void subscribeToJob(socket, auth, raw, ack);
    });

    socket.on('job:unsubscribe', (jobId: unknown) => {
      if (typeof jobId === 'string' && jobId.length > 0) {
        void socket.leave(jobRoom(jobId));
      }
    });
  });

  setRealtimeServer(io);
  return io;
}

async function joinStandingRooms(socket: Socket, auth: AuthContext): Promise<void> {
  // Zones are not tenant-scoped and the list is small and static, so this is a
  // plain read on the base client rather than a scoped one.
  const zoneIds =
    auth.role === 'DISPATCHER'
      ? (await prismaBase.zone.findMany({ select: { id: true } })).map((zone) => zone.id)
      : [];

  const rooms = standingRoomsFor(auth, zoneIds);
  if (rooms.length > 0) {
    await socket.join(rooms);
  }

  logger.debug({ userId: auth.userId, role: auth.role, rooms }, 'socket connected');
}

async function subscribeToJob(
  socket: Socket,
  auth: AuthContext,
  raw: unknown,
  ack?: (result: SubscribeAck) => void,
): Promise<void> {
  const request = parseSubscribeRequest(raw);
  if (!request || !mayRequestJobRoom(auth.role)) {
    ack?.({ ok: false });
    return;
  }
  const jobId = request.jobId;

  // AWAIT INSIDE THE CONTEXT, NOT OUTSIDE IT.
  // `prisma.job.findFirst()` returns a lazy PrismaPromise: it does no work, and
  // the tenant-scope and ownership extensions do not run, until it is awaited.
  // Handing the un-awaited promise back out of `runWithAuthContext` means the
  // AsyncLocalStorage scope has already exited by the time those extensions
  // ask who the caller is, so they see no context, fall back to NO_TENANT, and
  // the query matches nothing. The HTTP path never hit this because
  // `authenticate` wraps the whole remaining request in the context. It fails
  // closed, which is the right direction, but it fails silently — an owner is
  // refused their own job.
  const job = await runWithAuthContext(auth, async () =>
    prisma.job.findFirst({ where: { id: jobId }, select: { id: true } }),
  );

  if (!job) {
    ack?.({ ok: false });
    return;
  }

  // JOIN BEFORE REPLAYING, never the other way round. Anything committed
  // between the two arrives live as well as in the replay, and the client drops
  // the repeat by sequence. Reading first and joining after would instead lose
  // whatever committed in the gap, and a missing event is undetectable.
  await socket.join(jobRoom(job.id));
  ack?.({ ok: true });

  if (request.lastEventSequence === undefined) return;

  const replay = await replayJobEvents(job.id, request.lastEventSequence);
  socket.emit('job:replay', replay);
}
