import express, { type Response } from 'express';
import type {
  CommandResult,
  ServerMessage,
  SnapshotResponse,
  StructuredError,
} from '../shared/types';
import { ActionRegistry } from './actionRegistry';
import { DeterminismError } from './engine';
import { DEFAULT_PRESET_ID, PRESETS } from './presets';
import { SessionManager, SimulationSession } from './session';

const SSE_HEARTBEAT_MS = 15_000;

export interface AppOptions {
  registry: ActionRegistry;
  manager?: SessionManager;
}

export function createApp(opts: AppOptions) {
  const app = express();
  const manager = opts.manager ?? new SessionManager(opts.registry);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, sessions: manager.size, registryActions: opts.registry.names() });
  });

  app.get('/api/presets', (_req, res) => {
    res.json({
      presets: PRESETS.map(({ machine, scenario, ...meta }) => ({ ...meta, machine, scenario })),
      defaultId: DEFAULT_PRESET_ID,
    });
  });

  app.post('/api/sessions', (req, res) => {
    try {
      const { machine, scenario, ttlMs } = req.body ?? {};
      if (!machine || !scenario) {
        return sendError(res, 400, {
          code: 'BAD_REQUEST',
          message: '需要 machine 与 scenario',
          phase: 'session',
          at: 0,
        });
      }
      const session = manager.create(machine, scenario, typeof ttlMs === 'number' ? ttlMs : undefined);
      const body = {
        sessionId: session.id,
        status: session.sessionStatus,
        expiresAt: session.snapshot().expiresAt,
      };
      res.status(201).json(body);
    } catch (e) {
      sendError(res, 400, toStructured(e));
    }
  });

  const withSession = (
    req: express.Request,
    res: Response,
    fn: (s: SimulationSession) => void,
  ): boolean => {
    const s = manager.get(req.params.id);
    if (!s) {
      sendError(res, 404, {
        code: 'SESSION_NOT_FOUND',
        message: '会话不存在或已过期',
        phase: 'session',
        at: 0,
      });
      return false;
    }
    fn(s);
    return true;
  };

  const reply = (res: Response, result: CommandResult) => {
    if (result.ok) res.json(result.snapshot);
    else sendError(res, 409, result.error);
  };

  app.get('/api/sessions/:id', (req, res) => {
    withSession(req, res, (s) => res.json(s.snapshot()));
  });

  app.post('/api/sessions/:id/play', (req, res) => {
    withSession(req, res, (s) => reply(res, s.command(req.body ?? {}, () => s.play(req.body ?? {}))));
  });

  app.post('/api/sessions/:id/pause', (req, res) => {
    withSession(req, res, (s) => reply(res, s.command(req.body ?? {}, () => s.pause())));
  });

  app.post('/api/sessions/:id/step', (req, res) => {
    withSession(req, res, (s) => reply(res, s.command(req.body ?? {}, () => s.step())));
  });

  app.post('/api/sessions/:id/jump', (req, res) => {
    withSession(req, res, (s) =>
      reply(res, s.command(req.body ?? {}, () => s.jump(Number((req.body as { toSeq?: number }).toSeq)))),
    );
  });

  app.post('/api/sessions/:id/reset', (req, res) => {
    withSession(req, res, (s) =>
      reply(res, s.command(req.body ?? {}, () => s.reset((req.body as { scenario: never }).scenario))),
    );
  });

  app.post('/api/sessions/:id/events', (req, res) => {
    withSession(req, res, (s) => reply(res, s.command(req.body ?? {}, () => s.enqueue(req.body))));
  });

  // SSE：Last-Event-ID 或 ?afterSeq= 指明最后确认步骤，服务端从其后续传
  app.get('/api/sessions/:id/stream', (req, res) => {
    const session = manager.get(req.params.id);
    if (!session) {
      return sendError(res, 404, {
        code: 'SESSION_NOT_FOUND',
        message: '会话不存在或已过期',
        phase: 'session',
        at: 0,
      });
    }

    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const write = (msg: ServerMessage) => {
      // id 行置于事件之前，浏览器重连时自动回送为 Last-Event-ID
      if (msg.type === 'step') res.write(`id: ${msg.step.seq}\n`);
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    };

    let lastSeq = 0;
    const lei = req.header('last-event-id');
    if (lei && /^\d+$/.test(lei)) lastSeq = Number(lei);
    else if (typeof req.query.afterSeq === 'string' && /^\d+$/.test(req.query.afterSeq)) {
      lastSeq = Number(req.query.afterSeq);
    }

    const unsubscribe = session.subscribe((msg) => {
      if (msg.type === 'expired') {
        write(msg);
        end();
        return;
      }
      write(msg);
    });

    session.replaySince(lastSeq, write);

    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    function end() {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
    req.on('close', end);
  });

  return { app, manager };
}

function sendError(res: Response, status: number, error: StructuredError): void {
  res.status(status).json({ ok: false, error });
}

function toStructured(e: unknown): StructuredError {
  if (e instanceof DeterminismError) return e.structured;
  return {
    code: 'BAD_REQUEST',
    message: e instanceof Error ? e.message : String(e),
    phase: 'session',
    at: 0,
  };
}

export function startServer(port = 3001, registry?: ActionRegistry) {
  const reg = registry ?? new ActionRegistry();
  const { app } = createApp({ registry: reg });
  return app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[fsm-workbench] API + SSE on http://localhost:${port}`);
  });
}
