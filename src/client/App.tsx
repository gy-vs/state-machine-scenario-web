import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonObject, MachineDef, ScenarioDef, SnapshotResponse, Step } from '../shared/types';
import { api, ApiError, SessionStream } from './api';
import {
  Failures,
  JsonEditor,
  QueueView,
  StatusBadge,
  StepDetail,
  kindBadge,
} from './components';

interface Preset {
  id: string;
  title: string;
  description: string;
  machine: MachineDef;
  scenario: ScenarioDef;
}

type ConnectionState = 'connecting' | 'open' | 'offline' | 'expired';

export function App() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState<string>('');
  const [machine, setMachine] = useState<MachineDef | null>(null);
  const [scenario, setScenario] = useState<ScenarioDef | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [conn, setConn] = useState<ConnectionState>('connecting');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [jumpTo, setJumpTo] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ttlText, setTtlText] = useState('30');
  const streamRef = useRef<SessionStream | null>(null);
  const liveSteps = useRef<Map<number, Step>>(new Map());

  // 加载预置
  useEffect(() => {
    fetch('/api/presets')
      .then((r) => r.json())
      .then((data: { presets: Preset[]; defaultId: string }) => {
        setPresets(data.presets);
        setPresetId(data.defaultId);
        const p = data.presets.find((x) => x.id === data.defaultId) ?? data.presets[0];
        if (p) {
          setMachine(structuredClone(p.machine));
          setScenario(structuredClone(p.scenario));
        }
      });
  }, []);

  const selectPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setMachine(structuredClone(p.machine));
    setScenario(structuredClone(p.scenario));
  };

  // SSE 生命周期
  useEffect(() => {
    if (!sessionId) return;
    setConn('connecting');
    liveSteps.current = new Map();
    const stream = new SessionStream(
      sessionId,
      {
        onStep: (msg) => {
          liveSteps.current.set(msg.step.seq, msg.step);
          setSnapshot((prev) => (prev ? mergeStep(prev, msg.step) : prev));
          // 终止/耗尽类步骤无法仅靠单步信息对账（队列终结），整量拉取一次
          if (['terminated', 'boundary', 'expired'].includes(msg.step.kind) && streamRef.current) {
            void api.snapshot(sessionId).then((s) => {
              liveSteps.current = new Map(s.steps.map((x: Step) => [x.seq, x]));
              setSnapshot(s);
            });
          }
        },
        onStatus: (msg) => {
          setSnapshot((prev) => (prev ? { ...prev, status: msg.status } : prev));
        },
        onSnapshot: (msg) => {
          liveSteps.current = new Map(msg.payload.steps.map((s: Step) => [s.seq, s]));
          setSnapshot(msg.payload);
        },
        onError: (msg) => {
          if (msg.error.code === 'REPLAY_TRUNCATED') {
            setNotice(`重连续传已被截断，服务端已用整量快照重新同步：${msg.error.message}`);
          } else {
            setNotice(`[${msg.error.code}] ${msg.error.message}`);
          }
        },
        onExpired: () => {
          setConn('expired');
          setNotice('会话已过期（TTL 到期），请新建会话。');
        },
        onHello: () => {
          /* 续传握手完成 */
        },
      },
      0,
      (open) => setConn(open ? 'open' : 'offline'),
    );
    streamRef.current = stream;
    return () => stream.close();
  }, [sessionId]);

  const refreshSnapshot = useCallback(async (id: string) => {
    const s = await api.snapshot(id);
    liveSteps.current = new Map(s.steps.map((x: Step) => [x.seq, x]));
    setSnapshot(s);
  }, []);

  const createSession = async () => {
    if (!machine || !scenario) return;
    setBusy(true);
    setNotice(null);
    try {
      const ttlMs = Math.max(1, Number(ttlText) || 30) * 1000;
      const created = await api.createSession({ machine, scenario, ttlMs });
      setSessionId(created.sessionId);
      await refreshSnapshot(created.sessionId);
      setSelectedSeq(null);
    } catch (e) {
      setNotice(formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  const runCommand = async (verb: string, extra?: Record<string, unknown>) => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const s = await api.command(sessionId, verb, extra);
      setSnapshot(s);
      setSelectedSeq(null);
    } catch (e) {
      setNotice(formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  const doJump = async () => {
    const n = Number(jumpTo);
    if (!Number.isInteger(n) || n < 0) return;
    await runCommand('jump', { toSeq: n });
  };

  const resetSession = async () => {
    if (!sessionId || !scenario) return;
    setBusy(true);
    try {
      const s = await api.command(sessionId, 'reset', { scenario });
      liveSteps.current = new Map(s.steps.map((x: Step) => [x.seq, x]));
      setSnapshot(s);
      setSelectedSeq(null);
      setNotice(null);
    } catch (e) {
      setNotice(formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  const steps = snapshot?.steps ?? [];
  const selectedStep: Step | undefined =
    selectedSeq != null ? steps.find((s) => s.seq === selectedSeq) : undefined;
  const prevStep: Step | undefined = selectedStep
    ? [...steps].reverse().find((s) => s.seq < selectedStep.seq && s.kind !== 'canceled')
    : undefined;

  const expiresIn = useTtl(snapshot?.expiresAt);

  return (
    <div className="app">
      <header className="topbar">
        <h1>状态机情景验证工作台</h1>
        <span className="sub">确定性虚拟时钟 · 同刻决胜 · 取消/回滚 · 单步流式仿真</span>
        <div style={{ flex: 1 }} />
        <label className="row">
          <span className="muted">预置</span>
          <select value={presetId} onChange={(e) => selectPreset(e.target.value)} style={{ minWidth: 240 }}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="layout">
        {/* 左列：定义 */}
        <div className="col">
          <div className="card">
            <h2>情景 / 机器定义</h2>
            {presets.find((p) => p.id === presetId)?.description && (
              <div className="warn-box" style={{ marginBottom: 8 }}>
                {presets.find((p) => p.id === presetId)?.description}
              </div>
            )}
            <label className="muted">会话 TTL（秒，最小 1，便于测试过期）</label>
            <div className="row" style={{ margin: '6px 0 10px' }}>
              <input value={ttlText} onChange={(e) => setTtlText(e.target.value)} style={{ width: 80 }} />
              <button className="primary" disabled={busy || !machine} onClick={createSession}>
                {sessionId ? '按当前定义新建会话' : '创建会话并开始'}
              </button>
              <button disabled={busy || !sessionId} onClick={resetSession}>
                重置情景
              </button>
            </div>

            <h3 style={{ fontSize: 12, margin: '8px 0 4px' }}>machine.json（状态 / 转移 / 守卫 / 动作）</h3>
            {machine && (
              <JsonEditor value={machine} onChange={(v) => setMachine(v as MachineDef)} height={260} />
            )}
            <h3 style={{ fontSize: 12, margin: '10px 0 4px' }}>scenario.json（初始事件 / 取消信号 / 优先级）</h3>
            {scenario && (
              <JsonEditor value={scenario} onChange={(v) => setScenario(v as ScenarioDef)} height={180} />
            )}
            <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
              守卫：<span className="mono">ctx.count + 1</span> ·{' '}
              <span className="mono">event.payload.ok === true</span> ·{' '}
              <span className="mono">ctx.x ? "a" : "b"</span> ·{' '}
              <span className="mono">"k" in ctx.meta</span>
            </div>
          </div>

          <InjectEventsCard
            sessionId={sessionId}
            currentTime={snapshot?.currentTime ?? 0}
            disabled={busy || !sessionId}
            onDone={async () => sessionId && refreshSnapshot(sessionId)}
            onError={(e) => setNotice(formatErr(e))}
          />
        </div>

        {/* 右列：运行与检查 */}
        <div className="col">
          <div className="card">
            <div className="row">
              <StatusBadge status={snapshot?.status ?? 'idle'} />
              <span className="badge">
                <span className={`dot ${conn === 'open' ? 'green' : conn === 'expired' ? 'red' : 'amber'}`} />
                SSE {conn}
              </span>
              <span className="badge mono">
                t={snapshot?.currentTime ?? 0} · 步骤 {steps.length}
              </span>
              <span className="badge mono">最后确认 #{snapshot?.lastAppliedSeq ?? 0}</span>
              <span className="badge mono">缓冲起 #{snapshot?.bufferedFromSeq ?? '-'}</span>
              {sessionId && (
                <span className={`badge mono ${expiresIn < 5000 ? 'red-text' : 'muted'}`}>
                  {expiresIn > 0 ? `${Math.ceil(expiresIn / 1000)}s 后过期` : '已过期'}
                </span>
              )}
              <div style={{ flex: 1 }} />
              <button className="primary" disabled={busy || !sessionId} onClick={() => runCommand('play', { wait: 350 })}>
                ▶ 继续播放
              </button>
              <button disabled={busy || !sessionId} onClick={() => runCommand('pause')}>
                ⏸ 暂停
              </button>
              <button disabled={busy || !sessionId} onClick={() => runCommand('step')}>
                ⏭ 单步
              </button>
              <span className="row">
                <input
                  placeholder="跳到序号"
                  value={jumpTo}
                  onChange={(e) => setJumpTo(e.target.value)}
                  style={{ width: 90 }}
                />
                <button disabled={busy || !sessionId} onClick={doJump}>
                  跳转
                </button>
              </span>
            </div>
            {notice && (
              <div className="error-box" style={{ marginTop: 8 }} onAnimationStart={() => undefined}>
                <span style={{ float: 'right', cursor: 'pointer' }} onClick={() => setNotice(null)}>
                  ✕
                </span>
                {notice}
              </div>
            )}
          </div>

          <div className="card">
            <h2>当前状态 / 上下文</h2>
            {snapshot ? (
              <div className="grid2">
                <div>
                  <div className="state-pill">{snapshot.state}</div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    注入动作：{snapshot.registryActions.join(', ') || '（无）'}
                  </div>
                  <div className="muted">机内动作：{snapshot.machineActions.join(', ') || '（无）'}</div>
                </div>
                <pre className="json">{JSON.stringify(snapshot.context, null, 2)}</pre>
              </div>
            ) : (
              <div className="muted">尚未创建会话</div>
            )}
          </div>

          <div className="card">
            <h2>待处理事件队列（按确定性排序键）</h2>
            {snapshot ? <QueueView queue={snapshot.queue} /> : <div className="muted">—</div>}
          </div>

          <Failures failures={snapshot?.failures ?? []} />

          <div className="card">
            <h2>步骤流（点击查看单步差异）</h2>
            {steps.length === 0 ? (
              <div className="muted">尚无步骤，按“单步”或“继续播放”推进虚拟时钟。</div>
            ) : (
              <div className="grid2" style={{ alignItems: 'start' }}>
                <div className="scroll tall">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>序键</th>
                        <th>事件</th>
                        <th>转移</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {steps.map((s) => (
                        <tr
                          key={s.seq}
                          className={`step-row ${selectedSeq === s.seq ? 'selected' : ''}`}
                          onClick={() => setSelectedSeq(s.seq)}
                        >
                          <td className="mono">{s.seq}</td>
                          <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                            t{s.time}/L{s.lane}/p{s.priority}
                          </td>
                          <td className="mono" style={{ maxWidth: 170, overflow: 'hidden' }}>
                            {s.eventType}
                          </td>
                          <td className="mono" style={{ maxWidth: 150, overflow: 'hidden' }}>
                            {s.stateChanged ? (
                              <span className="green-text">
                                {s.fromState}→{s.toState}
                              </span>
                            ) : (
                              <span className="muted">
                                {s.fromState}→{s.toState}
                              </span>
                            )}
                          </td>
                          <td>{kindBadge(s.kind)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  {selectedStep ? (
                    <StepDetail step={selectedStep} prev={prevStep} />
                  ) : (
                    <div className="muted">选择左侧任一步骤检查守卫、动作、派发、取消与上下文差异。</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function applyPatch(base: JsonObject, entries: NonNullable<Step['diff']>): JsonObject {
  let next = structuredClone(base);
  for (const d of entries) {
    next = setByPath(next, d.path, d.kind === 'remove' ? undefined : d.newValue, d.kind === 'remove') as JsonObject;
  }
  return next;
}

function setByPath(target: unknown, path: string, value: unknown, remove: boolean): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: Record<string, unknown> = target as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (remove) delete cur[last];
  else cur[last] = value;
  return target;
}

function mergeStep(prev: SnapshotResponse, step: Step): SnapshotResponse {
  const without = prev.steps.filter((s) => s.seq !== step.seq);
  const steps = [...without, step].sort((a, b) => a.seq - b.seq);

  // 乐观补丁：状态、时间、上下文（应用步骤）
  let state = prev.state;
  let context = prev.context;
  if (step.kind === 'applied') {
    state = step.toState;
    context = step.diff?.length ? applyPatch(prev.context, step.diff) : prev.context;
  }

  // 队列：按确定性顺序重建
  const queue = mergeQueue(prev, step);

  return {
    ...prev,
    steps,
    state,
    context,
    currentTime: Math.max(prev.currentTime, step.time),
    queue,
    lastAppliedSeq: Math.max(prev.lastAppliedSeq, ['applied', 'skipped', 'canceled', 'rolled-back', 'terminated'].includes(step.kind) ? step.seq : 0),
  };
}

function mergeQueue(prev: SnapshotResponse, step: Step) {
  // 增量维护：每个步骤（applied/skipped/rolled-back 等）都恰好消费自身事件；
  // canceled 步骤与信号的 cancellations 移除被取消者；raised 追加新事件。
  let q = prev.queue.filter((e) => e.id !== step.eventId);
  if (step.kind === 'canceled') {
    // 该事件已在信号步骤中通过 cancellations 移除，无需再处理
  }
  for (const c of step.cancellations ?? []) {
    q = q.filter((e) => !(c.mode === 'id' ? e.id === c.ref : e.type === c.ref));
  }
  for (const r of step.raised ?? []) {
    if (!q.some((e) => e.id === r.id)) {
      q.push({
        id: r.id,
        type: r.type,
        at: r.at,
        lane: r.lane,
        priority: r.priority,
        seq: 0, // 动作派发的同优先级事件，界面上以 lane 次序展示即可
        origin: 'action',
      });
    }
  }
  return q.sort((a, b) => a.at - b.at || a.lane - b.lane || b.priority - a.priority);
}

function formatErr(e: unknown): string {
  if (e instanceof ApiError) return `[${e.structured.phase}/${e.structured.code}] ${e.structured.message}`;
  return e instanceof Error ? e.message : String(e);
}

function useTtl(expiresAt?: number): number {
  const [remain, setRemain] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setRemain(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);
  return remain;
}

function InjectEventsCard(props: {
  sessionId: string | null;
  currentTime: number;
  disabled: boolean;
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const [id, setId] = useState('ext-1');
  const [type, setType] = useState('SUBMIT');
  const [at, setAt] = useState('0');
  const [payload, setPayload] = useState('{}');
  const [priority, setPriority] = useState('0');
  const [cancelRef, setCancelRef] = useState('');
  const [cancelMode, setCancelMode] = useState<'id' | 'type'>('id');

  const submit = async () => {
    if (!props.sessionId) return;
    let parsedPayload: JsonObject | undefined;
    try {
      parsedPayload = payload.trim() ? (JSON.parse(payload) as JsonObject) : undefined;
    } catch (e) {
      props.onError(e);
      return;
    }
    try {
      await api.enqueue(props.sessionId, {
        commandId: undefined,
        id: id || `ext-${Date.now()}`,
        type,
        at: Number(at),
        payload: parsedPayload,
        priority: Number(priority) || 0,
        cancelRef: cancelRef || undefined,
        cancelMode: cancelRef ? cancelMode : undefined,
      });
      await props.onDone();
    } catch (e) {
      props.onError(e);
    }
  };

  const atNum = Number(at);
  const inPast = atNum < props.currentTime;

  return (
    <div className="card">
      <h2>运行中注入事件（外部激励）</h2>
      <div className="grid2">
        <label className="muted">
          id
          <input value={id} onChange={(e) => setId(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label className="muted">
          type
          <input value={type} onChange={(e) => setType(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label className="muted">
          at（虚拟时刻）
          <input type="number" value={at} onChange={(e) => setAt(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label className="muted">
          priority
          <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label className="muted">
          payload JSON
          <input value={payload} onChange={(e) => setPayload(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label className="muted">
          取消 ref（可空）
          <input value={cancelRef} onChange={(e) => setCancelRef(e.target.value)} style={{ width: '100%' }} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <select value={cancelMode} onChange={(e) => setCancelMode(e.target.value as 'id' | 'type')}>
          <option value="id">按 id 取消</option>
          <option value="type">按 type 取消</option>
        </select>
        {inPast && <span className="red-text">at={atNum} 早于当前时刻 {props.currentTime}，将被拒绝</span>}
        <div style={{ flex: 1 }} />
        <button className="primary" disabled={props.disabled} onClick={submit}>
          注入
        </button>
      </div>
    </div>
  );
}
