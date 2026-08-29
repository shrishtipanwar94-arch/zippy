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

export function createRealtimeServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
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
