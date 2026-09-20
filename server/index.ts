// Express + WebSocket 服务端入口

import express from 'express';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultRegistry } from './registry';
import { SessionManager } from './session';
import type { ClientMsg, MachineDef, ScenarioDef } from '../shared/types';

const PORT = Number(process.env.PORT ?? 3001);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 15 * 60 * 1000);

const manager = new SessionManager(defaultRegistry(), SESSION_TTL_MS);

const app = express();
app.use(express.json({ limit: '1mb' }));

function validate(body: unknown): { machine: MachineDef; scenario: ScenarioDef } {
  const { machine, scenario } = (body ?? {}) as { machine?: MachineDef; scenario?: ScenarioDef };
  if (!machine || typeof machine !== 'object') throw new Error('missing machine definition');
  if (!machine.initial || !machine.states || typeof machine.states !== 'object') {
    throw new Error('machine must have initial and states');
  }
  if (!machine.states[machine.initial]) {
    throw new Error(`initial state '${machine.initial}' is not defined in states`);
  }
  if (!scenario || !Array.isArray(scenario.steps)) throw new Error('scenario.steps must be an array');
  for (const step of scenario.steps) {
    if (typeof step.at !== 'number' || step.at < 0) throw new Error('scenario step needs a non-negative "at"');
  }
  if (scenario.onError != null && scenario.onError !== 'rollback' && scenario.onError !== 'abort') {
    throw new Error('scenario.onError must be "rollback" or "abort"');
  }
  return { machine, scenario };
}

app.post('/api/sessions', (req, res) => {
  try {
    const { machine, scenario } = validate(req.body);
    const session = manager.create(machine, scenario);
    res.json({ sessionId: session.id, snapshot: session.snapshot() });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  const s = manager.get(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'SESSION_EXPIRED', message: 'session not found or expired' });
    return;
  }
  res.json({ snapshot: s.snapshot() });
});

// 演示/测试用：强制让会话过期
app.post('/api/sessions/:id/expire', (req, res) => {
  const ok = manager.destroy(req.params.id);
  res.status(ok ? 200 : 404).json({ expired: ok });
});

app.delete('/api/sessions/:id', (req, res) => {
  const ok = manager.destroy(req.params.id);
  res.status(ok ? 200 : 404).json({ destroyed: ok });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  let sessionId: string | null = null;

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'attach': {
        const s = manager.get(msg.sessionId);
        if (!s) {
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'SESSION_EXPIRED',
              message: 'session not found or expired',
              seq: 0,
            }),
          );
          return;
        }
        sessionId = s.id;
        s.attach(ws, Math.max(0, msg.lastAck ?? 0));
        break;
      }
      case 'control':
        manager.get(sessionId ?? '')?.control(msg.op, msg.count);
        break;
      case 'inject':
        manager.get(sessionId ?? '')?.inject(msg.event, msg.delay);
        break;
      case 'ack':
        manager.get(sessionId ?? '')?.touch();
        break;
      case 'destroy':
        if (sessionId) manager.destroy(sessionId);
        break;
    }
  });

  ws.on('close', () => {
    if (sessionId) manager.get(sessionId)?.detach(ws);
  });
});

setInterval(() => {
  const expired = manager.sweep();
  if (expired.length > 0) console.log(`[sweep] expired sessions: ${expired.join(', ')}`);
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`state machine workbench server on http://localhost:${PORT}`);
});
