import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MachineDef,
  QueuedEventView,
  ScenarioDef,
  ServerMsgEnvelope,
  SessionStatus,
  Snapshot,
  StepRecord,
} from '../../shared/types';

// ---------- 默认示例：覆盖同刻竞争 / 嵌套派发 / 取消竞争 / 失败回滚 ----------

const DEFAULT_MACHINE: MachineDef = {
  initial: 'idle',
  context: { progress: 0, log: [] },
  states: {
    idle: {
      on: { START: { target: 'downloading', actions: ['appendLog', 'raiseTick'] } },
    },
    downloading: {
      on: {
        TICK: [
          { guard: 'progressDone', target: 'done', actions: ['appendLog', 'markComplete'] },
          { target: 'downloading', actions: ['bumpProgress', 'appendLog', 'raiseTick'] },
        ],
        PAUSE: { target: 'paused', actions: ['appendLog'] },
        RISKY: { target: 'failed', actions: ['explodingAction'] },
      },
    },
    paused: {
      on: {
        RESUME: { target: 'downloading', actions: ['appendLog', 'raiseTick'] },
        CANCEL: { target: 'cancelled', actions: ['appendLog'] },
      },
    },
    done: { on: {} },
    failed: { on: {} },
    cancelled: { on: {} },
  },
};

const DEFAULT_SCENARIO: ScenarioDef = {
  name: 'demo',
  onError: 'rollback',
  steps: [
    { at: 0, send: [{ type: 'START' }] },
    // 同刻竞争：PAUSE 与 RESUME 同在 t=7，priority 决定顺序
    { at: 7, send: [{ type: 'PAUSE', priority: 0 }, { type: 'RESUME', priority: 1 }] },
    // 失败回滚：RISKY 的动作会抛错；与嵌套派生的 TICK 同刻（t=12）
    { at: 12, send: [{ type: 'RISKY' }] },
    // 取消与完成竞争：t=20 的取消信号 vs 嵌套派生的 TICK（token=tick）
    { at: 20, cancel: 'tick', priority: 0 },
  ],
};

const LS_SESSION = 'smw.sessionId';
const LS_ACK = 'smw.lastAck';

type ConnState = 'offline' | 'connecting' | 'online';

function fmt(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 60 ? s.slice(0, 57) + '…' : s;
}

export default function App() {
  const [machineText, setMachineText] = useState(() => JSON.stringify(DEFAULT_MACHINE, null, 2));
  const [scenarioText, setScenarioText] = useState(() => JSON.stringify(DEFAULT_SCENARIO, null, 2));
  const [sessionId, setSessionId] = useState(() => localStorage.getItem(LS_SESSION) ?? '');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [queue, setQueue] = useState<QueuedEventView[]>([]);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [conn, setConn] = useState<ConnState>('offline');
  const [banner, setBanner] = useState('');
  const [lastAck, setLastAck] = useState(() => Number(localStorage.getItem(LS_ACK) ?? 0));
  const [injectType, setInjectType] = useState('PING');
  const [injectDelay, setInjectDelay] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const lastAckRef = useRef(lastAck);
  const manualCloseRef = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const updateAck = useCallback((seq: number) => {
    if (seq > lastAckRef.current) {
      lastAckRef.current = seq;
      setLastAck(seq);
      localStorage.setItem(LS_ACK, String(seq));
    }
  }, []);

  const connect = useCallback(
    (sid: string) => {
      if (!sid) return;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      setConn('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConn('online');
        const msg = { type: 'attach', sessionId: sid, lastAck: lastAckRef.current };
        ws.send(JSON.stringify(msg));
      };
      ws.onmessage = (e) => {
        const env = JSON.parse(e.data as string) as ServerMsgEnvelope;
        switch (env.type) {
          case 'hello':
            break;
          case 'snapshot':
            setSnapshot(env.snapshot);
            setQueue(env.snapshot.queue);
            setStatus(env.snapshot.status);
            break;
          case 'resync':
            setSteps([]); // 缓冲截断：丢弃本地日志，以快照 + 后续条目为准
            setBanner('事件缓冲已截断，已以服务端快照重新同步');
            break;
          case 'step': {
            if (env.seq <= lastAckRef.current) break; // 去重：绝不重复应用
            updateAck(env.seq);
            setSteps((prev) => [env.step, ...prev].slice(0, 300));
            setQueue(env.queue);
            setStatus(env.status);
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    status: env.status,
                    clock: env.step.clock,
                    state: env.step.to,
                    stepsApplied: env.step.n,
                  }
                : prev,
            );
            ws.send(JSON.stringify({ type: 'ack', seq: env.seq }));
            break;
          }
          case 'status':
            if (env.seq > lastAckRef.current) updateAck(env.seq);
            setStatus(env.status);
            setSnapshot((prev) => (prev ? { ...prev, status: env.status } : prev));
            break;
          case 'error':
            if (env.code === 'SESSION_EXPIRED') {
              setBanner('会话已过期或被销毁，请重新创建');
              localStorage.removeItem(LS_SESSION);
              localStorage.removeItem(LS_ACK);
              lastAckRef.current = 0;
              setLastAck(0);
              setSessionId('');
              setSnapshot(null);
              setSteps([]);
              setQueue([]);
            } else {
              setBanner(`${env.code}: ${env.message}`);
            }
            break;
        }
      };
      ws.onclose = () => {
        setConn('offline');
        wsRef.current = null;
        if (!manualCloseRef.current && sid) {
          reconnectTimer.current = setTimeout(() => connect(sid), 1000); // 自动重连
        }
        manualCloseRef.current = false;
      };
    },
    [updateAck],
  );

  useEffect(() => {
    if (sessionId) connect(sessionId);
    return () => clearTimeout(reconnectTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const createSession = useCallback(async () => {
    setBanner('');
    let machine: MachineDef;
    let scenario: ScenarioDef;
    try {
      machine = JSON.parse(machineText);
      scenario = JSON.parse(scenarioText);
    } catch (e) {
      setBanner(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine, scenario }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBanner(`创建失败: ${body.error}`);
      return;
    }
    // 新会话：重置确认游标与本地日志
    lastAckRef.current = 0;
    setLastAck(0);
    localStorage.setItem(LS_ACK, '0');
    localStorage.setItem(LS_SESSION, body.sessionId);
    setSteps([]);
    setSnapshot(body.snapshot);
    setQueue(body.snapshot.queue);
    setStatus(body.snapshot.status);
    setSessionId(body.sessionId);
  }, [machineText, scenarioText]);

  const destroySession = useCallback(() => {
    send({ type: 'destroy' });
    localStorage.removeItem(LS_SESSION);
    localStorage.removeItem(LS_ACK);
    lastAckRef.current = 0;
    setLastAck(0);
    setSessionId('');
    setSnapshot(null);
    setSteps([]);
    setQueue([]);
    setStatus('idle');
    wsRef.current?.close();
  }, [send]);

  const simulateDrop = useCallback(() => {
    // 模拟断线：手动关闭后自动重连逻辑会按 lastAck 续传
    manualCloseRef.current = false;
    wsRef.current?.close();
  }, []);

  const control = (op: string, count?: number) => send({ type: 'control', op, count });

  return (
    <div className="app">
      <header>
        <h1>状态机情景验证工作台</h1>
        <div className="header-meta">
          <span className={`badge conn-${conn}`}>
            {conn === 'online' ? '已连接' : conn === 'connecting' ? '连接中' : '离线'}
          </span>
          <span className={`badge status-${status}`}>状态: {status}</span>
          {sessionId && <span className="mono">会话 {sessionId.slice(0, 8)}…</span>}
          <span className="mono">ack #{lastAck}</span>
        </div>
      </header>

      {banner && <div className="banner">{banner}</div>}

      <main>
        <section className="col editors">
          <h2>状态机定义</h2>
          <textarea
            value={machineText}
            onChange={(e) => setMachineText(e.target.value)}
            spellCheck={false}
            rows={18}
          />
          <h2>情景编排</h2>
          <textarea
            value={scenarioText}
            onChange={(e) => setScenarioText(e.target.value)}
            spellCheck={false}
            rows={12}
          />
          <div className="row">
            <button className="primary" onClick={createSession}>
              创建会话
            </button>
            <button onClick={destroySession} disabled={!sessionId}>
              销毁会话
            </button>
          </div>
          <details>
            <summary>可用守卫 / 动作（服务端注册表）</summary>
            <p className="hint">
              守卫: always, never, progressDone, payloadFlag, explodingGuard
              <br />
              动作: assign, bumpProgress, raiseTick, cancelToken, appendLog, markComplete,
              explodingAction
            </p>
          </details>
        </section>

        <section className="col">
          <h2>执行控制</h2>
          <div className="row">
            <button className="primary" onClick={() => control('start')} disabled={!sessionId}>
              运行
            </button>
            <button onClick={() => control('pause')} disabled={!sessionId}>
              暂停
            </button>
            <button onClick={() => control('resume')} disabled={!sessionId}>
              继续
            </button>
            <button onClick={() => control('step', 1)} disabled={!sessionId}>
              单步
            </button>
            <button onClick={() => control('step', 10)} disabled={!sessionId}>
              步进 ×10
            </button>
          </div>
          <div className="row">
            <button onClick={simulateDrop} disabled={!sessionId}>
              模拟断线重连
            </button>
            <input
              value={injectType}
              onChange={(e) => setInjectType(e.target.value)}
              placeholder="事件类型"
              size={8}
            />
            <input
              type="number"
              value={injectDelay}
              onChange={(e) => setInjectDelay(Number(e.target.value))}
              placeholder="延迟"
              size={4}
              min={0}
            />
            <button
              onClick={() => send({ type: 'inject', event: { type: injectType }, delay: injectDelay })}
              disabled={!sessionId}
            >
              注入事件
            </button>
          </div>

          <h2>当前状态</h2>
          {snapshot ? (
            <div className="panel">
              <div className="kv">
                <span>虚拟时钟</span>
                <b className="mono">{snapshot.clock}</b>
              </div>
              <div className="kv">
                <span>状态</span>
                <b className="mono state-name">{snapshot.state}</b>
              </div>
              <div className="kv">
                <span>已应用步数</span>
                <b className="mono">{snapshot.stepsApplied}</b>
              </div>
              <div className="kv">
                <span>上下文</span>
              </div>
              <pre className="context">{JSON.stringify(snapshot.context, null, 2)}</pre>
            </div>
          ) : (
            <p className="hint">创建会话后显示</p>
          )}

          <h2>事件队列 ({queue.length})</h2>
          <div className="panel queue">
            {queue.length === 0 ? (
              <p className="hint">空</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>t</th>
                    <th>事件</th>
                    <th>pri</th>
                    <th>token</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.slice(0, 30).map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{e.time}</td>
                      <td className="mono">{e.type}</td>
                      <td className="mono">{e.priority}</td>
                      <td className="mono">{e.token ?? ''}</td>
                      <td>{e.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="col">
          <h2>步骤日志（单步差异）</h2>
          <div className="panel steps">
            {steps.length === 0 ? (
              <p className="hint">尚无步骤</p>
            ) : (
              steps.map((s) => <StepRow key={s.n} step={s} />)
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function StepRow({ step: s }: { step: StepRecord }) {
  const cls = s.error ? 'step error' : s.rolledBack ? 'step rolledback' : s.transition ? 'step' : 'step muted';
  return (
    <div className={cls}>
      <div className="step-head">
        <span className="mono">#{s.n}</span>
        <span className="mono">t={s.clock}</span>
        <b className="mono">{s.event.type}</b>
        <span className="mono">
          {s.from} → {s.to}
        </span>
        {s.rolledBack && <span className="tag warn">已回滚</span>}
        {s.note && <span className="tag">{s.note}</span>}
      </div>
      {s.guards.length > 0 && (
        <div className="step-line">
          守卫:{' '}
          {s.guards.map((g, i) => (
            <span key={i} className={`tag ${g.ok ? 'ok' : 'warn'}`}>
              {g.name}={g.ok ? '✓' : '✗'}
            </span>
          ))}
        </div>
      )}
      {s.diff.length > 0 && (
        <div className="step-line">
          {s.diff.map((d) => (
            <div key={d.key} className="diff">
              <span className="mono">{d.key}</span>: <del>{fmt(d.before)}</del> →{' '}
              <ins>{fmt(d.after)}</ins>
            </div>
          ))}
        </div>
      )}
      {s.raised.length > 0 && (
        <div className="step-line">
          派生:{' '}
          {s.raised.map((r, i) => (
            <span key={i} className="tag">
              {r.type}@t={r.time}
              {r.token ? ` (${r.token})` : ''}
            </span>
          ))}
        </div>
      )}
      {s.cancelled.length > 0 && (
        <div className="step-line">
          取消:{' '}
          {s.cancelled.map((c) => (
            <span key={c.id} className="tag warn">
              {c.type}#{c.id}
            </span>
          ))}
        </div>
      )}
      {s.error && (
        <div className="step-line error-text">
          [{s.error.code}] {s.error.action ?? s.error.guard ?? ''}: {s.error.message}
        </div>
      )}
    </div>
  );
}
