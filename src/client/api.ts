import type {
  CommandRequest,
  CreateSessionRequest,
  EnqueueRequest,
  ServerMessage,
  SnapshotResponse,
  StructuredError,
} from '../shared/types';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, public structured: StructuredError) {
    super(structured.message);
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? {
      code: 'HTTP_ERROR',
      message: `HTTP ${res.status}`,
      phase: 'session',
      at: 0,
    });
  }
  return body as T;
}

let commandCounter = 0;
function commandId(prefix: string): string {
  commandCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${commandCounter}`;
}

export const api = {
  async createSession(req: CreateSessionRequest): Promise<{ sessionId: string; status: string; expiresAt: number }> {
    return jsonFetch(`${API_BASE}/sessions`, { method: 'POST', body: JSON.stringify(req) });
  },

  async command(id: string, verb: string, body?: Record<string, unknown>): Promise<SnapshotResponse> {
    return jsonFetch(`${API_BASE}/sessions/${id}/${verb}`, {
      method: 'POST',
      body: JSON.stringify({ commandId: commandId(verb), ...body } satisfies CommandRequest & Record<string, unknown>),
    });
  },

  async enqueue(id: string, req: EnqueueRequest): Promise<SnapshotResponse> {
    return jsonFetch(`${API_BASE}/sessions/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({ commandId: commandId('enqueue'), ...req }),
    });
  },

  async snapshot(id: string): Promise<SnapshotResponse> {
    return jsonFetch(`${API_BASE}/sessions/${id}`);
  },

  streamUrl(id: string, afterSeq?: number): string {
    const base = `${API_BASE}/sessions/${id}/stream`;
    return afterSeq ? `${base}?afterSeq=${afterSeq}` : base;
  },
};

export type StreamHandlers = {
  onStep?: (msg: Extract<ServerMessage, { type: 'step' }>) => void;
  onStatus?: (msg: Extract<ServerMessage, { type: 'status' }>) => void;
  onSnapshot?: (msg: Extract<ServerMessage, { type: 'snapshot' }>) => void;
  onError?: (msg: Extract<ServerMessage, { type: 'error' }>) => void;
  onExpired?: () => void;
  onHello?: (msg: Extract<ServerMessage, { type: 'hello' }>) => void;
};

/**
 * SSE 连接管理。EventSource 自带重连并回送 Last-Event-ID；
 * 服务端从该序号之后续传，客户端按 seq 去重，保证不重复应用。
 */
export class SessionStream {
  private es: EventSource | null = null;
  private closedByUser = false;
  private seenSeq = new Set<number>();

  constructor(
    private sessionId: string,
    private handlers: StreamHandlers,
    private afterSeq = 0,
    private onConnectionChange?: (open: boolean) => void,
  ) {
    this.connect();
  }

  private connect(): void {
    const url = api.streamUrl(this.sessionId, this.afterSeq || undefined);
    const es = new EventSource(url);
    this.es = es;

    es.onopen = () => this.onConnectionChange?.(true);

    es.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'step':
          if (this.seenSeq.has(msg.step.seq)) return;
          this.seenSeq.add(msg.step.seq);
          this.afterSeq = Math.max(this.afterSeq, msg.step.seq);
          this.handlers.onStep?.(msg);
          break;
        case 'status':
          this.handlers.onStatus?.(msg);
          break;
        case 'snapshot':
          for (const s of msg.payload.steps) this.seenSeq.add(s.seq);
          this.handlers.onSnapshot?.(msg);
          break;
        case 'error':
          this.handlers.onError?.(msg);
          break;
        case 'expired':
          this.handlers.onExpired?.();
          this.close();
          break;
        case 'hello':
          this.handlers.onHello?.(msg);
          break;
      }
    };

    es.onerror = () => {
      this.onConnectionChange?.(false);
      // readyState===CLOSED 且非用户主动关闭时，手动重建（携带已确认 seq）
      if (es.readyState === EventSource.CLOSED && !this.closedByUser) {
        setTimeout(() => {
          if (!this.closedByUser) this.connect();
        }, 400);
      }
    };
  }

  close(): void {
    this.closedByUser = true;
    this.es?.close();
    this.es = null;
  }
}
