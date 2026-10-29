import type {
  AuditEvent,
  CommandResult,
  ControllerEventRequest,
  ControllerEventResult,
  HistoryQuery,
  JunctionStatus,
  JunctionSummary,
  ManualCommandRequest,
  SensorEventRequest,
  SensorEventResult,
} from "@/types/traffic";

/**
 * Contract shared by the real HTTP backend client and the standalone mock engine.
 * React components only depend on this interface.
 */
export interface TrafficService {
  readonly kind: "DEMO" | "LIVE";
  listJunctions(): Promise<JunctionSummary[]>;
  getJunction(junctionId: string): Promise<JunctionSummary>;
  getStatus(junctionId: string): Promise<JunctionStatus>;
  getHistory(junctionId: string, query?: HistoryQuery): Promise<AuditEvent[]>;
  postSensorEvent(event: SensorEventRequest): Promise<SensorEventResult>;
  postManualCommand(junctionId: string, command: ManualCommandRequest): Promise<CommandResult>;
  postControllerEvent(event: ControllerEventRequest): Promise<ControllerEventResult>;
}

export type ApiErrorKind = "network" | "http" | "parse";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly kind: ApiErrorKind,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const DEFAULT_API_BASE_URL = "http://localhost:3000/api";

export function resolveApiBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return (fromEnv && fromEnv.trim()) || DEFAULT_API_BASE_URL;
}

/**
 * Thin REST client for the Node.js + Express + PostgreSQL/Prisma backend.
 * It never invents state: every value shown in LIVE mode comes from these responses.
 */
export class HttpTrafficService implements TrafficService {
  readonly kind = "LIVE" as const;
  constructor(
    public readonly baseUrl: string = resolveApiBaseUrl(),
    private readonly timeoutMs = 5000,
  ) {}

  private async request<T>(path: string, init?: RequestInit, acceptStatuses: number[] = []): Promise<{ status: number; body: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json", ...init?.headers },
      });
    } catch (err) {
      const reason = err instanceof DOMException && err.name === "AbortError" ? "timed out" : "unreachable";
      throw new ApiError(`Backend ${reason} at ${this.baseUrl}`, "network");
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError(`Invalid JSON from ${path}`, "parse", res.status);
      }
    }
    if (!res.ok && !acceptStatuses.includes(res.status)) {
      const msg = (body as { message?: string; error?: string } | null)?.message ?? (body as { error?: string } | null)?.error ?? res.statusText;
      throw new ApiError(`HTTP ${res.status}: ${msg}`, "http", res.status, body);
    }
    return { status: res.status, body: body as T };
  }

  async listJunctions() {
    const { body } = await this.request<JunctionSummary[] | { junctions: JunctionSummary[] }>("/junctions");
    return Array.isArray(body) ? body : (body?.junctions ?? []);
  }

  async getJunction(id: string) {
    return (await this.request<JunctionSummary>(`/junctions/${encodeURIComponent(id)}`)).body;
  }

  async getStatus(id: string) {
    const { body } = await this.request<JunctionStatus>(`/junctions/${encodeURIComponent(id)}/status`);
    if (!body || typeof body !== "object" || !("stage" in body)) {
      throw new ApiError("Status payload missing required fields", "parse");
    }
    return { ...body, alerts: body.alerts ?? [], queues: body.queues ?? { total_waiting: 0, by_direction: {} } };
  }

  async getHistory(id: string, query?: HistoryQuery) {
    const qs = query?.limit ? `?limit=${query.limit}` : "";
    const { body } = await this.request<AuditEvent[] | { events: AuditEvent[] }>(`/junctions/${encodeURIComponent(id)}/history${qs}`);
    return Array.isArray(body) ? body : (body?.events ?? []);
  }

  async postSensorEvent(event: SensorEventRequest): Promise<SensorEventResult> {
    const { status, body } = await this.request<Partial<SensorEventResult>>(
      "/sensor-events",
      { method: "POST", body: JSON.stringify(event) },
      [400, 404, 409, 422],
    );
    return {
      result: body?.result ?? mapStatusToResult(status),
      http_status: status,
      event_id: body?.event_id ?? event.event_id,
      correlation_id: body?.correlation_id ?? "—",
      message: body?.message ?? `HTTP ${status}`,
    };
  }

  async postManualCommand(id: string, command: ManualCommandRequest): Promise<CommandResult> {
    const { status, body } = await this.request<Partial<CommandResult>>(
      `/junctions/${encodeURIComponent(id)}/commands`,
      { method: "POST", body: JSON.stringify(command) },
      [400, 409, 422],
    );
    return {
      result: body?.result ?? (status < 300 ? "accepted" : "rejected"),
      http_status: status,
      request_id: body?.request_id ?? command.request_id,
      correlation_id: body?.correlation_id ?? "—",
      message: body?.message ?? `HTTP ${status}`,
      manual_request: body?.manual_request ?? null,
    };
  }

  async postControllerEvent(event: ControllerEventRequest): Promise<ControllerEventResult> {
    const { status, body } = await this.request<Partial<ControllerEventResult>>(
      "/controller-events",
      { method: "POST", body: JSON.stringify(event) },
      [400, 409, 422],
    );
    return {
      result: body?.result ?? (status < 300 ? "accepted" : "rejected"),
      http_status: status,
      event_id: body?.event_id ?? event.event_id,
      correlation_id: body?.correlation_id ?? "—",
      message: body?.message ?? `HTTP ${status}`,
    };
  }
}

function mapStatusToResult(status: number): SensorEventResult["result"] {
  if (status === 200) return "duplicate";
  if (status < 300) return "accepted";
  if (status === 409) return "stale";
  return "rejected";
}
