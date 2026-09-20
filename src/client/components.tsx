import { useEffect, useMemo, useState } from 'react';
import type { DiffEntry, QueueEntryView, SnapshotResponse, Step } from '../shared/types';

export function JsonEditor(props: {
  value: unknown;
  onChange?: (value: unknown) => void;
  height?: number;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(() => safeStringify(props.value));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setText(safeStringify(props.value));
    setErr(null);
    // 外部 value 变化（切换预置/会话）时同步
  }, [props.value]);

  const onChange = (v: string) => {
    setText(v);
    if (props.readOnly) return;
    try {
      const parsed = JSON.parse(v);
      setErr(null);
      props.onChange?.(parsed);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div>
      <textarea
        style={{ height: props.height ?? 220, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
        value={text}
        readOnly={props.readOnly}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {err && <div className="error-box" style={{ marginTop: 6 }}>JSON 错误：{err}</div>}
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function kindBadge(kind: Step['kind']) {
  return <span className={`kind kind-${kind}`}>{kind}</span>;
}

export function StatusBadge({ status }: { status: SnapshotResponse['status'] }) {
  const color =
    status === 'running'
      ? 'green'
      : status === 'paused'
        ? 'amber'
        : status === 'expired' || status === 'terminated'
          ? 'red'
          : 'muted';
  return (
    <span className="badge">
      <span className={`dot ${color}`} />
      {status}
    </span>
  );
}

export function QueueView({ queue }: { queue: QueueEntryView[] }) {
  if (!queue.length) return <div className="muted">队列为空</div>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>序键</th>
            <th>id / type</th>
            <th>来源</th>
            <th>payload</th>
            <th>取消</th>
          </tr>
        </thead>
        <tbody>
          {queue.map((e) => (
            <tr key={`${e.id}-${e.seq}`}>
              <td className="mono">
                t={e.at} L{e.lane} p={e.priority} #{e.seq}
              </td>
              <td className="mono">
                <div>{e.id}</div>
                <div className="muted">{e.type}</div>
              </td>
              <td>
                <span className="badge">{e.origin}</span>
              </td>
              <td className="mono" style={{ maxWidth: 180, overflow: 'hidden' }}>
                {e.payload ? JSON.stringify(e.payload) : <span className="muted">—</span>}
              </td>
              <td className="mono amber-text">
                {e.cancelRef ? `${e.cancelMode ?? 'id'}:${e.cancelRef}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DiffView({ diff }: { diff?: DiffEntry[] }) {
  if (!diff || diff.length === 0) return <div className="muted">无上下文变化</div>;
  return (
    <table>
      <tbody>
        {diff.map((d) => (
          <tr key={`${d.kind}-${d.path}`}>
            <td>
              <span className={`diff-${d.kind}`}>{d.kind}</span>
            </td>
            <td className="mono">{d.path || '$'}</td>
            <td className="mono red-text">{d.kind !== 'add' ? compact(d.oldValue) : ''}</td>
            <td className="mono green-text">{d.kind !== 'remove' ? compact(d.newValue) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function compact(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + '...' : s ?? 'undefined';
}

export function StepDetail({ step, prev }: { step: Step; prev?: Step }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {kindBadge(step.kind)}
        <span className="mono">#{step.seq}</span>
        <span className="mono muted">{step.orderKey}</span>
      </div>
      <dl className="kv">
        <dt>事件</dt>
        <dd>
          {step.eventId} → {step.eventType}
        </dd>
        <dt>状态</dt>
        <dd>
          <span className={step.stateChanged ? 'amber-text' : 'muted'}>{step.fromState}</span>
          {' → '}
          <span className={step.stateChanged ? 'green-text' : ''}>{step.toState}</span>
        </dd>
        <dt>转移</dt>
        <dd>{step.takenTransitionOn ? `on=${step.takenTransitionOn}${step.target ? ` → ${step.target}` : ' (自转换)'}` : '—'}</dd>
        <dt>动作</dt>
        <dd>{step.actions?.length ? step.actions.join('，') : '—'}</dd>
        <dt>派发</dt>
        <dd>
          {step.raised?.length
            ? step.raised.map((r) => `${r.type}@t${r.at}/L${r.lane}(${r.id})`).join('，')
            : '—'}
        </dd>
        <dt>取消</dt>
        <dd className="amber-text">
          {step.cancellations?.length
            ? step.cancellations.map((c) => `${c.mode}:${c.ref} by ${c.byEventId}`).join('，')
            : '—'}
        </dd>
      </dl>

      {step.guardRejects?.length ? (
        <div className="warn-box" style={{ marginTop: 6 }}>
          未通过守卫：{step.guardRejects.map((x) => x.source ?? x.on).join('；')}
        </div>
      ) : null}
      {step.error && (
        <div className="error-box" style={{ marginTop: 6 }}>
          <strong>[{step.error.phase}/{step.error.code}]</strong> {step.error.message}
          {step.error.action ? ` @action=${step.error.action}` : ''}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <div className="muted" style={{ marginBottom: 4 }}>
          单步上下文差异
        </div>
        <DiffView diff={step.diff} />
      </div>

      {step.payload !== undefined && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted">事件 payload</summary>
          <pre className="json">{JSON.stringify(step.payload, null, 2)}</pre>
        </details>
      )}
      {prev && <CompareContext after={step} before={prev} />}
    </div>
  );
}

function CompareContext({ after, before }: { after: Step; before: Step }) {
  return (
    <details style={{ marginTop: 8 }}>
      <summary className="muted">
        与上一步上下文对比（t={before.time} #{before.seq}）
      </summary>
      <div className="grid2">
        <div>
          <div className="muted">before</div>
          <pre className="json">{JSON.stringify(before, null, 2).length > 0 ? '(见步骤流上下文)' : ''}</pre>
        </div>
        <div>
          <div className="muted">after（diff 已在上）</div>
          <pre className="json">{`#${after.seq} ${after.kind}`}</pre>
        </div>
      </div>
    </details>
  );
}

export function Failures({ failures }: { failures: SnapshotResponse['failures'] }) {
  const recent = useMemo(() => failures.slice(-8), [failures]);
  if (!recent.length) return null;
  return (
    <div className="card">
      <h2>结构化错误 / 引擎警告（{failures.length}）</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {recent.map((f, i) => (
          <div key={i} className={f.phase === 'engine' ? 'warn-box' : 'error-box'}>
            <span className="mono">t={f.at}</span> [{f.phase}/{f.code}] {f.message}
            {f.eventId ? ` · event=${f.eventId}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
