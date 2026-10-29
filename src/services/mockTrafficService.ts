/**
 * MOCK / DEMO control engine — non-production simulator.
 *
 * Every scheduling rule, ACK gate and controller emulation for DEMO mode is
 * confined to this file. React components never compute transitions; in LIVE
 * mode the real backend owns all of this.
 *
 * Simulation assumptions (documented, not certified):
 *  - Yellow clearance 5 s from ACK, all-red 2 s from ACK.
 *  - Automatic minimum green 10 s, normal (max) green ~30 s.
 *  - Queue weights EMPLOYEE=1, FORKLIFT=2, TRUCK=4; age bonus +1 / 15 s, capped at 8 per vehicle.
 *  - Starvation guard at 90 s oldest wait.
 *  - Controller ACK timeout 3 s → FAULT_LOCKOUT with UNKNOWN actual state.
 *  - Manual green lease 120 s; precedence SAFETY/FAULT > EMERGENCY > MANUAL > AUTOMATIC.
 */
import {
  DIRECTIONS,
  PHASE_DIRECTIONS,
  VEHICLE_TYPES,
  otherPhase,
  phaseOf,
  type Alert,
  type AlertSeverity,
  type AuditCategory,
  type AuditEvent,
  type CommandResult,
  type ControllerCommand,
  type ControllerEventRequest,
  type ControllerEventResult,
  type ControllerStatus,
  type Direction,
  type DirectionQueue,
  type EmergencyInfo,
  type HistoryQuery,
  type JunctionStatus,
  type JunctionSummary,
  type ManualCommandRequest,
  type ManualRequest,
  type ObservedSignalVector,
  type OperatingMode,
  type Phase,
  type PhysicalStateTrust,
  type SensorEventRequest,
  type SensorEventResult,
  type SignalVector,
  type Stage,
  type VehicleType,
} from "@/types/traffic";
import {
  ALL_RED_VECTOR,
  UNKNOWN_VECTOR,
  hasConflict,
  phaseVector,
  sanitizeObserved,
  vectorsEqual,
} from "@/lib/signals";
import type { TrafficService } from "./trafficApi";

export const SIM = {
  YELLOW_MS: 5_000,
  ALL_RED_MS: 2_000,
  MIN_GREEN_MS: 10_000,
  NORMAL_GREEN_MS: 30_000,
  ACK_TIMEOUT_MS: 3_000,
  HEARTBEAT_MS: 1_000,
  STALE_AFTER_MS: 3_000,
  MANUAL_LEASE_MS: 120_000,
  STARVATION_S: 90,
  AGE_BONUS_EVERY_S: 15,
  AGE_BONUS_CAP: 8,
  DEPARTURE_EVERY_MS: 2_500,
  WEIGHTS: { EMPLOYEE_VEHICLE: 1, FORKLIFT: 2, TRUCK: 4, EMERGENCY: 0 } as Record<VehicleType, number>,
} as const;

export type AckMode = "AUTO_ACK" | "DELAY_ACK" | "DROP_ACK" | "MISMATCH_ACK";

export interface EmulatorConfig {
  online: boolean;
  ackMode: AckMode;
  ackDelayMs: number;
  autoFlow: boolean;
  deviceSignals: SignalVector;
}

interface Vehicle {
  vehicle_id: string;
  vehicle_type: VehicleType;
  direction: Direction;
  arrived_at: number;
}

type Purpose =
  | { kind: "YELLOW"; from: Phase }
  | { kind: "ALL_RED" }
  | { kind: "GREEN"; to: Phase };

interface ScheduledDeviceEvent {
  at: number;
  apply?: SignalVector;
  event: Pick<ControllerEventRequest, "event_type" | "command_id" | "reported_signals">;
}

interface EngineState {
  stage: Stage;
  phase: Phase | null;
  targetPhase: Phase | null;
  lastServed: Phase | null;
  mode: OperatingMode;
  stageStartedAt: number;
  stageDeadline: number | null;
  greenConfirmedAt: number | null;
  desired: SignalVector;
  actual: ObservedSignalVector;
  actualObservedAt: number | null;
  trust: PhysicalStateTrust;
  controllerStatus: ControllerStatus;
  lastContact: number;
  lastHeartbeatSent: number;
  snapshotRequested: boolean;
  vehicles: Vehicle[];
  processedEvents: Map<string, SensorEventResult>;
  processedRequests: Map<string, CommandResult>;
  lastSeq: Record<Direction, number>;
  pending: ControllerCommand | null;
  pendingPurpose: Purpose | null;
  commands: ControllerCommand[];
  manual: ManualRequest | null;
  alerts: Alert[];
  history: AuditEvent[];
  decision: string;
  lastDepartureAt: number;
  device: EmulatorConfig;
  deviceQueue: ScheduledDeviceEvent[];
}

export interface MockOptions {
  now?: () => number;
  autoTick?: boolean;
  tickMs?: number;
  latencyMs?: number;
  seedVehicles?: boolean;
}

const JUNCTIONS: JunctionSummary[] = [
  { junction_id: "A", name: "Junction A — Dock Gate Crossing", location: "Plant 1 · Loading docks / Assembly hall", directions: [...DIRECTIONS] },
];

const yellowFor = (p: Phase) => phaseVector(p, "YELLOW");
const greenFor = (p: Phase) => phaseVector(p, "GREEN");

export class MockTrafficService implements TrafficService {
  readonly kind = "DEMO" as const;
  private s!: EngineState;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private counter = 0;
  private readonly now: () => number;
  private readonly latencyMs: number;
  private readonly seedVehicles: boolean;

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.latencyMs = opts.latencyMs ?? 40;
    this.seedVehicles = opts.seedVehicles ?? true;
    this.reset();
    if (opts.autoTick !== false) {
      this.timer = setInterval(() => this.tick(), opts.tickMs ?? 200);
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ───────────────────────── public mock-only controls ─────────────────────────

  reset() {
    const now = this.now();
    this.counter = 0;
    this.s = {
      stage: "STARTUP_RECONCILIATION",
      phase: null,
      targetPhase: null,
      lastServed: null,
      mode: "DEGRADED",
      stageStartedAt: now,
      stageDeadline: null,
      greenConfirmedAt: null,
      desired: { ...ALL_RED_VECTOR },
      actual: { ...UNKNOWN_VECTOR },
      actualObservedAt: null,
      trust: "UNKNOWN",
      controllerStatus: "ONLINE",
      lastContact: now,
      lastHeartbeatSent: now,
      snapshotRequested: false,
      vehicles: [],
      processedEvents: new Map(),
      processedRequests: new Map(),
      lastSeq: { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 },
      pending: null,
      pendingPurpose: null,
      commands: [],
      manual: null,
      alerts: [],
      history: [],
      decision: "Startup: awaiting controller snapshot before any phase is served",
      lastDepartureAt: now,
      device: { online: true, ackMode: "AUTO_ACK", ackDelayMs: 2_000, autoFlow: true, deviceSignals: { ...ALL_RED_VECTOR } },
      deviceQueue: [],
    };
    this.log("SYSTEM", "DEMO_RESET", { decision: "Mock engine reset; startup reconciliation begins" });
    if (this.seedVehicles) {
      const seed: Array<[Direction, VehicleType]> = [
        ["NORTH", "EMPLOYEE_VEHICLE"],
        ["NORTH", "FORKLIFT"],
        ["SOUTH", "EMPLOYEE_VEHICLE"],
        ["EAST", "TRUCK"],
        ["WEST", "EMPLOYEE_VEHICLE"],
      ];
      seed.forEach(([d, t], i) => this.ingestInternal("VEHICLE_ARRIVED", d, `SEED-${i + 1}`, t, "Seed fixture"));
    }
  }

  /** Advance the deterministic clock-driven engine (tests use an injected clock). */
  advance(ms: number, step = 100) {
    for (let t = 0; t < ms; t += step) this.tick();
  }

  getEmulator(): EmulatorConfig {
    return { ...this.s.device, deviceSignals: { ...this.s.device.deviceSignals } };
  }

  setEmulator(patch: Partial<Omit<EmulatorConfig, "deviceSignals">>) {
    const d = this.s.device;
    if (patch.online !== undefined && patch.online !== d.online) {
      d.online = patch.online;
      if (!patch.online) this.s.deviceQueue = [];
      this.log("CONTROLLER", patch.online ? "EMULATOR_LINK_RESTORED" : "EMULATOR_LINK_CUT", {
        decision: patch.online
          ? "Controller link restored. Junction stays locked until a fresh snapshot reconciles state."
          : "Controller stops responding; backend will detect missing heartbeat after 3 s.",
      });
      if (patch.online) {
        this.schedule(150, { event_type: "CONTROLLER_ONLINE" });
      }
    }
    if (patch.ackMode && patch.ackMode !== d.ackMode) {
      d.ackMode = patch.ackMode;
      this.log("CONTROLLER", "EMULATOR_ACK_MODE", { decision: `Emulated controller ACK behaviour → ${patch.ackMode}` });
    }
    if (patch.ackDelayMs !== undefined) d.ackDelayMs = Math.max(0, Math.min(10_000, patch.ackDelayMs));
    if (patch.autoFlow !== undefined) d.autoFlow = patch.autoFlow;
    this.tick();
  }

  /** Ask the emulated controller for a fresh full-junction snapshot (reconcile). */
  requestSnapshot(): { ok: boolean; message: string } {
    if (!this.s.device.online) {
      this.log("CONTROLLER", "SNAPSHOT_REQUEST_FAILED", { result: "unreachable", decision: "Controller offline — snapshot cannot be obtained" });
      return { ok: false, message: "Controller is offline; snapshot request not delivered." };
    }
    this.log("CONTROLLER", "SNAPSHOT_REQUESTED", { decision: "Fresh snapshot requested for reconciliation" });
    this.schedule(300, { event_type: "SNAPSHOT", reported_signals: { ...this.s.device.deviceSignals } });
    return { ok: true, message: "Snapshot requested; reconciliation starts when the controller reports." };
  }

  logScenario(name: string, description: string) {
    this.log("SYSTEM", "SCENARIO_STARTED", { decision: `Simulated demo: ${name} — ${description}` });
  }

  // ───────────────────────────── TrafficService API ─────────────────────────────

  async listJunctions() {
    return this.serialize(() => JUNCTIONS.map((j) => ({ ...j })));
  }

  async getJunction(id: string) {
    return this.serialize(() => {
      const j = JUNCTIONS.find((x) => x.junction_id === id);
      if (!j) throw new Error(`HTTP 404: junction ${id} not found`);
      return { ...j };
    });
  }

  async getStatus(id: string): Promise<JunctionStatus> {
    return this.serialize(() => {
      this.assertJunction(id);
      return this.snapshot();
    });
  }

  async getHistory(id: string, query?: HistoryQuery): Promise<AuditEvent[]> {
    return this.serialize(() => {
      this.assertJunction(id);
      return this.s.history.slice(0, query?.limit ?? 200).map((h) => ({ ...h }));
    });
  }

  async postSensorEvent(event: SensorEventRequest): Promise<SensorEventResult> {
    return this.serialize(() => {
      const r = this.ingest(event, "Sensor event");
      this.tick();
      return r;
    });
  }

  async postManualCommand(id: string, cmd: ManualCommandRequest): Promise<CommandResult> {
    return this.serialize(() => {
      const r = this.handleManual(id, cmd);
      this.tick();
      return r;
    });
  }

  async postControllerEvent(event: ControllerEventRequest): Promise<ControllerEventResult> {
    return this.serialize(() => {
      const r = this.handleControllerEvent(event, true);
      this.tick();
      return r;
    });
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(async () => {
      if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
      return fn();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private id(prefix: string) {
    this.counter += 1;
    return `${prefix}-${this.counter.toString(36).padStart(5, "0")}`;
  }

  private iso(ms: number | null | undefined) {
    return ms == null ? null : new Date(ms).toISOString();
  }

  private assertJunction(id: string) {
    if (id !== "A") throw new Error(`HTTP 404: junction ${id} not found`);
  }

  private log(
    category: AuditCategory,
    event_type: string,
    extra: Partial<Omit<AuditEvent, "id" | "timestamp" | "category" | "event_type">> = {},
  ) {
    this.s.history.unshift({
      id: this.id("evt"),
      timestamp: new Date(this.now()).toISOString(),
      category,
      event_type,
      stage: this.s.stage,
      mode: this.s.mode,
      ...extra,
    });
    if (this.s.history.length > 400) this.s.history.length = 400;
  }

  private raise(code: string, severity: AlertSeverity, message: string) {
    const existing = this.s.alerts.find((a) => a.code === code);
    if (existing) {
      existing.message = message;
      return;
    }
    this.s.alerts.unshift({ alert_id: this.id("alr"), code, severity, message, raised_at: new Date(this.now()).toISOString() });
  }

  private clearAlert(code: string) {
    this.s.alerts = this.s.alerts.filter((a) => a.code !== code);
  }

  private schedule(delayMs: number, event: ScheduledDeviceEvent["event"], apply?: SignalVector) {
    this.s.deviceQueue.push({ at: this.now() + delayMs, event, apply });
  }

  // ── vehicles & scoring

  private waitS(v: Vehicle, now = this.now()) {
    return Math.max(0, Math.floor((now - v.arrived_at) / 1000));
  }

  private vehicleScore(v: Vehicle, now = this.now()) {
    if (v.vehicle_type === "EMERGENCY") return 0;
    return SIM.WEIGHTS[v.vehicle_type] + Math.min(SIM.AGE_BONUS_CAP, Math.floor(this.waitS(v, now) / SIM.AGE_BONUS_EVERY_S));
  }

  phaseScore(p: Phase) {
    return this.s.vehicles.filter((v) => phaseOf(v.direction) === p).reduce((sum, v) => sum + this.vehicleScore(v), 0);
  }

  private phaseCount(p: Phase) {
    return this.s.vehicles.filter((v) => phaseOf(v.direction) === p).length;
  }

  private oldestWait(p: Phase) {
    const list = this.s.vehicles.filter((v) => phaseOf(v.direction) === p);
    return list.length ? Math.max(...list.map((v) => this.waitS(v))) : 0;
  }

  private emergency(): EmergencyInfo | null {
    const e = this.s.vehicles.filter((v) => v.vehicle_type === "EMERGENCY").sort((a, b) => a.arrived_at - b.arrived_at)[0];
    return e ? { vehicle_id: e.vehicle_id, direction: e.direction, phase: phaseOf(e.direction), since: new Date(e.arrived_at).toISOString() } : null;
  }

  private starvingPhase(): Phase | null {
    for (const p of ["NORTH_SOUTH", "EAST_WEST"] as Phase[]) {
      if (p !== this.s.phase && this.oldestWait(p) >= SIM.STARVATION_S) return p;
    }
    return null;
  }

  // ── sensor ingest

  private ingestInternal(type: "VEHICLE_ARRIVED" | "VEHICLE_CLEARED", direction: Direction, vehicle_id: string, vehicle_type: VehicleType | undefined, cause: string) {
    return this.ingest(
      {
        event_id: this.id("sim"),
        junction_id: "A",
        event_type: type,
        direction,
        vehicle_id,
        vehicle_type,
        sequence_no: this.s.lastSeq[direction] + 1,
        occurred_at: new Date(this.now()).toISOString(),
      },
      cause,
    );
  }

  private ingest(e: SensorEventRequest, cause: string): SensorEventResult {
    const correlation_id = this.id("corr");
    const base = { event_id: e?.event_id ?? "—", correlation_id };
    const reject = (http_status: number, message: string, result: SensorEventResult["result"] = "rejected"): SensorEventResult => {
      const r = { ...base, result, http_status, message };
      this.log(e?.vehicle_type === "EMERGENCY" ? "EMERGENCY" : "VEHICLE", e?.event_type ?? "INVALID_EVENT", {
        direction: DIRECTIONS.includes(e?.direction) ? e.direction : null,
        vehicle_id: e?.vehicle_id || null,
        vehicle_type: e?.vehicle_type ?? null,
        correlation_id,
        result,
        decision: `${result.toUpperCase()} (${http_status}): ${message}`,
      });
      return r;
    };

    // Idempotency first: a repeated event_id never mutates state again.
    if (e?.event_id && this.s.processedEvents.has(e.event_id)) {
      const prior = this.s.processedEvents.get(e.event_id)!;
      const r: SensorEventResult = { ...prior, result: "duplicate", http_status: 200, message: `Duplicate event_id; original result "${prior.result}" kept, no state change` };
      this.log("VEHICLE", e.event_type ?? "DUPLICATE", { direction: e.direction, vehicle_id: e.vehicle_id, correlation_id: prior.correlation_id, result: "duplicate", decision: r.message });
      return r;
    }

    if (!e || typeof e.event_id !== "string" || !e.event_id.trim()) return reject(400, "event_id is required");
    if (e.junction_id !== "A") return reject(404, `Unknown junction "${e.junction_id}"`);
    if (!DIRECTIONS.includes(e.direction)) return reject(400, "direction must be NORTH, SOUTH, EAST or WEST");
    if (e.event_type !== "VEHICLE_ARRIVED" && e.event_type !== "VEHICLE_CLEARED") return reject(400, "event_type must be VEHICLE_ARRIVED or VEHICLE_CLEARED");
    if (typeof e.vehicle_id !== "string" || !e.vehicle_id.trim()) return reject(400, "vehicle_id is required");
    if (!Number.isInteger(e.sequence_no) || e.sequence_no < 1) return reject(400, "sequence_no must be a positive integer");

    const store = (r: SensorEventResult) => {
      this.s.processedEvents.set(e.event_id, r);
      return r;
    };

    if (e.sequence_no <= this.s.lastSeq[e.direction]) {
      return store(reject(409, `Stale sequence_no ${e.sequence_no} ≤ last accepted ${this.s.lastSeq[e.direction]} for ${e.direction}`, "stale"));
    }

    if (e.event_type === "VEHICLE_ARRIVED") {
      if (!e.vehicle_type || !VEHICLE_TYPES.includes(e.vehicle_type)) return reject(400, "vehicle_type is required for VEHICLE_ARRIVED");
      if (this.s.vehicles.some((v) => v.vehicle_id === e.vehicle_id)) return store(reject(409, `Vehicle ${e.vehicle_id} is already queued`));
      this.s.vehicles.push({ vehicle_id: e.vehicle_id, vehicle_type: e.vehicle_type, direction: e.direction, arrived_at: this.now() });
    } else {
      const idx = this.s.vehicles.findIndex((v) => v.vehicle_id === e.vehicle_id && v.direction === e.direction);
      if (idx < 0) return store(reject(422, `Vehicle ${e.vehicle_id} is not queued at ${e.direction}; nothing to clear`));
      this.s.vehicles.splice(idx, 1);
    }
    this.s.lastSeq[e.direction] = e.sequence_no;
    const vt = e.vehicle_type ?? null;
    const r = store({ ...base, result: "accepted", http_status: 202, message: `${e.event_type} applied (${e.direction} seq ${e.sequence_no})` });
    this.log(vt === "EMERGENCY" ? "EMERGENCY" : "VEHICLE", e.event_type, {
      direction: e.direction,
      vehicle_id: e.vehicle_id,
      vehicle_type: vt,
      correlation_id,
      result: "accepted",
      decision: `${cause}; queue ${e.direction} = ${this.s.vehicles.filter((v) => v.direction === e.direction).length}`,
    });
    return r;
  }

  // ── manual commands

  private handleManual(id: string, cmd: ManualCommandRequest): CommandResult {
    const correlation_id = this.id("corr");
    const request_id = cmd?.request_id ?? "—";
    if (cmd?.request_id && this.s.processedRequests.has(cmd.request_id)) {
      return { ...this.s.processedRequests.get(cmd.request_id)!, result: "duplicate", http_status: 200, message: "Duplicate request_id; no change" };
    }
    const done = (r: CommandResult) => {
      if (cmd?.request_id) this.s.processedRequests.set(cmd.request_id, r);
      this.log("MANUAL", cmd?.command ?? "INVALID_COMMAND", {
        direction: cmd && "direction" in cmd ? cmd.direction : null,
        correlation_id,
        result: r.result,
        decision: r.message,
      });
      return r;
    };
    if (id !== "A") return done({ result: "rejected", http_status: 404, request_id, correlation_id, message: `Unknown junction ${id}` });
    if (this.s.stage === "FAULT_LOCKOUT") {
      return done({ result: "rejected", http_status: 409, request_id, correlation_id, message: "Rejected: junction in FAULT_LOCKOUT. Safety outranks manual control — reconcile the controller first." });
    }
    if (cmd.command === "RETURN_TO_AUTOMATIC") {
      const had = !!this.s.manual;
      this.s.manual = null;
      return done({ result: "accepted", http_status: 202, request_id, correlation_id, message: had ? "Manual lease released; automatic scheduling resumes." : "Already automatic; no active manual lease.", manual_request: null });
    }
    if (cmd.command !== "MANUAL_GREEN_REQUEST" || !DIRECTIONS.includes(cmd.direction)) {
      return done({ result: "rejected", http_status: 400, request_id, correlation_id, message: "command must be MANUAL_GREEN_REQUEST with a valid direction, or RETURN_TO_AUTOMATIC" });
    }
    const now = this.now();
    const phase = phaseOf(cmd.direction);
    const em = this.emergency();
    this.s.manual = {
      request_id,
      direction: cmd.direction,
      phase,
      requested_at: new Date(now).toISOString(),
      lease_expires_at: new Date(now + SIM.MANUAL_LEASE_MS).toISOString(),
      suspended_by_emergency: !!em && em.phase !== phase,
    };
    const msg = em && em.phase !== phase
      ? `Accepted with 120 s lease, but EMERGENCY at ${em.direction} outranks manual; request waits.`
      : this.s.phase === phase && this.s.stage.endsWith("_GREEN")
        ? `${phase} is already the confirmed green; holding it for the 120 s lease.`
        : `Safe transition to ${phase} requested (YELLOW 5 s → ALL RED 2 s → GREEN). Lamps change only after controller ACK.`;
    return done({ result: "accepted", http_status: 202, request_id, correlation_id, message: msg, manual_request: { ...this.s.manual } });
  }

  // ── controller events

  private handleControllerEvent(e: ControllerEventRequest | (Omit<ControllerEventRequest, "event_id" | "observed_at"> & { event_id?: string }), external: boolean): ControllerEventResult {
    const s = this.s;
    const now = this.now();
    const correlation_id = this.id("corr");
    const event_id = e.event_id ?? this.id("ctl");
    const res = (result: ControllerEventResult["result"], http_status: number, message: string): ControllerEventResult => ({ result, http_status, event_id, correlation_id, message });
    if (e.junction_id !== "A") return res("rejected", 404, `Unknown junction ${e.junction_id}`);

    const reported = e.reported_signals ? sanitizeObserved(e.reported_signals) : null;
    const reportedConcrete = reported && DIRECTIONS.every((d) => reported[d] !== "UNKNOWN") ? (reported as SignalVector) : null;
    if (external && e.event_type !== "CONTROLLER_OFFLINE") {
      // A controller that reports in is reachable; keep the emulator consistent with external reports.
      s.device.online = true;
      if (reportedConcrete) s.device.deviceSignals = { ...reportedConcrete };
    }

    if (e.event_type !== "CONTROLLER_OFFLINE") s.lastContact = now;

    switch (e.event_type) {
      case "HEARTBEAT": {
        if (s.stage === "FAULT_LOCKOUT" || s.pending || s.trust !== "CONFIRMED" || !reported) return res("accepted", 202, "Heartbeat recorded");
        if (!vectorsEqual(reported, s.actual)) {
          this.fault("STATE_MISMATCH", "MISMATCH", "Heartbeat reports signals different from the last confirmed state");
          return res("accepted", 202, "Heartbeat mismatch → FAULT_LOCKOUT");
        }
        s.actualObservedAt = now;
        return res("accepted", 202, "Heartbeat confirmed current state");
      }
      case "CONTROLLER_ONLINE": {
        if (external) s.device.online = true;
        this.log("CONTROLLER", "CONTROLLER_ONLINE", { correlation_id, decision: s.stage === "FAULT_LOCKOUT" ? "Controller reachable; junction remains locked until snapshot reconciliation" : "Controller online" });
        return res("accepted", 202, "Controller online recorded");
      }
      case "CONTROLLER_OFFLINE": {
        if (external) {
          s.device.online = false;
          s.deviceQueue = [];
        }
        s.lastContact = now - SIM.STALE_AFTER_MS - 1;
        this.fault("CONTROLLER_OFFLINE", "STALE", "Controller reported OFFLINE; physical state is stale");
        return res("accepted", 202, "Controller offline → FAULT_LOCKOUT");
      }
      case "SNAPSHOT": {
        if (!reported) return res("rejected", 400, "SNAPSHOT requires reported_signals");
        const conflict = hasConflict(e.reported_signals);
        if (conflict || !reportedConcrete) {
          this.fault("SNAPSHOT_INVALID", "UNKNOWN", "Snapshot contained conflicting or unknown lamps; state untrusted");
          return res("accepted", 202, "Snapshot unusable → remains locked");
        }
        const wasLocked = s.stage === "FAULT_LOCKOUT" || s.stage === "STARTUP_RECONCILIATION";
        if (!wasLocked && !s.pending && s.trust === "CONFIRMED" && !vectorsEqual(reportedConcrete, s.actual)) {
          this.fault("STATE_MISMATCH", "MISMATCH", "Snapshot differs from confirmed state");
          return res("accepted", 202, "Snapshot mismatch → FAULT_LOCKOUT");
        }
        s.actual = { ...reportedConcrete };
        s.actualObservedAt = now;
        s.trust = "CONFIRMED";
        if (wasLocked) {
          if (s.pending) {
            s.pending.status = "SUPERSEDED";
            s.pending = null;
            s.pendingPurpose = null;
          }
          s.stage = "STARTUP_RECONCILIATION";
          s.stageStartedAt = now;
          s.stageDeadline = null;
          s.phase = null;
          ["FAULT_LOCKOUT", "ACK_TIMEOUT", "ACK_MISMATCH", "STATE_MISMATCH", "CONTROLLER_OFFLINE", "HEARTBEAT_LOST", "SNAPSHOT_INVALID"].forEach((c) => this.clearAlert(c));
          s.decision = "Reconciliation: fresh snapshot trusted; commanding a safe stop before serving any phase";
          this.log("CONTROLLER", "SNAPSHOT_RECONCILED", { correlation_id, decision: `Snapshot ${fmtVec(reportedConcrete)} confirmed; safe-stop sequence follows` });
        }
        return res("accepted", 202, "Snapshot applied");
      }
      case "COMMAND_ACK": {
        const p = s.pending;
        if (!p || e.command_id !== p.command_id) {
          this.log("CONTROLLER", "ACK_IGNORED", { correlation_id, result: "ignored", decision: `ACK for ${e.command_id ?? "unknown"} has no matching pending command (late or unknown) — ignored` });
          return res("ignored", 409, "No matching pending command; late ACK ignored");
        }
        if (!reported) return res("rejected", 400, "COMMAND_ACK requires reported_signals");
        p.acknowledged_signals = reported;
        p.acked_at = new Date(now).toISOString();
        if (!vectorsEqual(reported, p.expected_signals)) {
          p.status = "MISMATCH";
          this.fault("ACK_MISMATCH", "MISMATCH", `Controller ACK ${fmtVec(reported)} ≠ expected ${fmtVec(p.expected_signals)}`);
          return res("accepted", 202, "ACK mismatch → FAULT_LOCKOUT");
        }
        p.status = "ACKED";
        s.actual = { ...p.expected_signals };
        s.actualObservedAt = now;
        s.trust = "CONFIRMED";
        const purpose = s.pendingPurpose;
        s.pending = null;
        s.pendingPurpose = null;
        this.log("CONTROLLER", "COMMAND_ACKED", { correlation_id, decision: `${p.command_id} confirmed ${fmtVec(p.expected_signals)}` });
        if (purpose) this.applyPurpose(purpose, now);
        return res("accepted", 202, "ACK matched expected vector");
      }
      default:
        return res("rejected", 400, "Unknown controller event_type");
    }
  }

  private applyPurpose(p: Purpose, at: number) {
    const s = this.s;
    s.stageStartedAt = at;
    if (p.kind === "YELLOW") {
      s.stage = p.from === "NORTH_SOUTH" ? "NORTH_SOUTH_YELLOW" : "EAST_WEST_YELLOW";
      s.phase = p.from;
      s.stageDeadline = at + SIM.YELLOW_MS;
    } else if (p.kind === "ALL_RED") {
      s.stage = "ALL_RED";
      s.phase = null;
      s.stageDeadline = at + SIM.ALL_RED_MS;
    } else {
      s.stage = p.to === "NORTH_SOUTH" ? "NORTH_SOUTH_GREEN" : "EAST_WEST_GREEN";
      s.phase = p.to;
      s.lastServed = p.to;
      s.targetPhase = null;
      s.greenConfirmedAt = at;
      s.lastDepartureAt = at;
      s.stageDeadline = at + SIM.NORMAL_GREEN_MS;
    }
    this.log("CONTROLLER", "STAGE_CHANGED", { decision: `Controller-confirmed stage → ${s.stage}` });
  }

  private issueCommand(expected: SignalVector, purpose: Purpose, reason: string) {
    const s = this.s;
    const now = this.now();
    if (hasConflict(expected)) throw new Error("Refusing to issue conflicting signal command");
    const cmd: ControllerCommand = {
      command_id: this.id("cmd"),
      command_type: "SET_SIGNALS",
      expected_signals: { ...expected },
      status: "PENDING",
      issued_at: new Date(now).toISOString(),
      ack_deadline: new Date(now + SIM.ACK_TIMEOUT_MS).toISOString(),
      acked_at: null,
      reason,
    };
    s.pending = cmd;
    s.pendingPurpose = purpose;
    s.desired = { ...expected };
    s.decision = reason;
    s.commands.unshift(cmd);
    if (s.commands.length > 25) s.commands.length = 25;
    this.log("CONTROLLER", "COMMAND_ISSUED", { correlation_id: cmd.command_id, decision: `${reason} → expect ${fmtVec(expected)}; awaiting ACK ≤ 3 s` });

    const d = s.device;
    if (!d.online) return;
    const ack = (reported: SignalVector) => ({ event_type: "COMMAND_ACK" as const, command_id: cmd.command_id, reported_signals: reported });
    switch (d.ackMode) {
      case "AUTO_ACK":
        this.schedule(150, ack(expected), expected);
        break;
      case "DELAY_ACK":
        this.schedule(d.ackDelayMs, ack(expected), expected);
        break;
      case "DROP_ACK":
        break;
      case "MISMATCH_ACK": {
        const wrong = { ...expected, NORTH: expected.NORTH === "RED" ? "YELLOW" : "RED" } as SignalVector;
        const safeWrong = hasConflict(wrong) ? { ...ALL_RED_VECTOR, NORTH: "YELLOW" as const } : wrong;
        this.schedule(150, ack(safeWrong), safeWrong);
        break;
      }
    }
  }

  private fault(code: string, trust: PhysicalStateTrust, message: string) {
    const s = this.s;
    if (s.pending) {
      if (s.pending.status === "PENDING") s.pending.status = code === "ACK_TIMEOUT" ? "TIMED_OUT" : "SUPERSEDED";
      s.pending = null;
      s.pendingPurpose = null;
    }
    s.trust = trust;
    s.actual = { ...UNKNOWN_VECTOR };
    s.desired = { ...ALL_RED_VECTOR };
    s.targetPhase = null;
    s.decision = `FAULT_LOCKOUT: ${message}. Fail-safe ALL RED requested; actual lamps unverified.`;
    this.raise(code, "CRITICAL", message);
    if (s.stage !== "FAULT_LOCKOUT") {
      s.stage = "FAULT_LOCKOUT";
      s.phase = null;
      s.stageStartedAt = this.now();
      s.stageDeadline = null;
      this.raise("FAULT_LOCKOUT", "CRITICAL", "Junction locked out; operator reconciliation required");
    }
    this.log("FAULT", code, { result: trust, decision: s.decision });
    this.refreshDerived();
  }

  private refreshDerived() {
    const s = this.s;
    const now = this.now();
    const fresh = now - s.lastContact <= SIM.STALE_AFTER_MS;
    s.controllerStatus = s.stage === "FAULT_LOCKOUT" ? (fresh && s.device.online ? "DEGRADED" : "OFFLINE") : "ONLINE";
    const em = this.emergency();
    if (s.manual) s.manual.suspended_by_emergency = !!em && em.phase !== s.manual.phase;
    const mode: OperatingMode =
      s.stage === "FAULT_LOCKOUT" || s.controllerStatus !== "ONLINE" || s.trust !== "CONFIRMED"
        ? "DEGRADED"
        : em
          ? "EMERGENCY"
          : s.manual
            ? "MANUAL"
            : "AUTOMATIC";
    if (mode !== s.mode) {
      s.mode = mode;
      this.log(mode === "EMERGENCY" ? "EMERGENCY" : mode === "MANUAL" ? "MANUAL" : mode === "DEGRADED" ? "FAULT" : "SYSTEM", "MODE_CHANGED", { decision: `Operating mode → ${mode}` });
    }
    if (em) this.raise("EMERGENCY_ACTIVE", "WARNING", `Emergency vehicle ${em.vehicle_id} at ${em.direction}; ${em.phase} prioritised via safe transition`);
    else this.clearAlert("EMERGENCY_ACTIVE");
    const starving = this.starvingPhase();
    if (starving) this.raise("STARVATION", "WARNING", `${starving} oldest wait ≥ ${SIM.STARVATION_S} s`);
    else this.clearAlert("STARVATION");
    if (s.manual) this.raise("MANUAL_ACTIVE", "INFO", `Manual lease for ${s.manual.direction} (${s.manual.phase})`);
    else this.clearAlert("MANUAL_ACTIVE");
  }

  private chooseTarget(): { phase: Phase; reason: string } {
    const em = this.emergency();
    if (em) return { phase: em.phase, reason: `Emergency preemption (${em.vehicle_id} @ ${em.direction})` };
    if (this.s.manual && !this.s.manual.suspended_by_emergency) return { phase: this.s.manual.phase, reason: `Manual request ${this.s.manual.direction}` };
    const starving = this.starvingPhase();
    if (starving) return { phase: starving, reason: "Starvation guard (≥ 90 s)" };
    if (this.s.targetPhase) return { phase: this.s.targetPhase, reason: "Scheduled next phase" };
    const ns = this.phaseScore("NORTH_SOUTH");
    const ew = this.phaseScore("EAST_WEST");
    if (ns > ew) return { phase: "NORTH_SOUTH", reason: `Weighted demand NS ${ns} > EW ${ew}` };
    if (ew > ns) return { phase: "EAST_WEST", reason: `Weighted demand EW ${ew} > NS ${ns}` };
    const p = this.s.lastServed ? otherPhase(this.s.lastServed) : "NORTH_SOUTH";
    return { phase: p, reason: "Equal demand; alternate phase" };
  }

  private decideSwitch(current: Phase): string | null {
    const s = this.s;
    const q = otherPhase(current);
    const elapsed = this.now() - (s.greenConfirmedAt ?? this.now());
    const em = this.emergency();
    if (em) return em.phase === q ? `Emergency preemption: ${em.vehicle_id} at ${em.direction} — safe transition` : null;
    if (s.manual && !s.manual.suspended_by_emergency) return s.manual.phase === q ? `Manual request ${s.manual.direction} — safe transition` : null;
    if (this.phaseCount(q) === 0) return null;
    if (elapsed < SIM.MIN_GREEN_MS) return null;
    if (this.oldestWait(q) >= SIM.STARVATION_S) return `Starvation guard: ${q} waited ≥ ${SIM.STARVATION_S} s`;
    if (elapsed >= SIM.NORMAL_GREEN_MS) return `Normal green ${SIM.NORMAL_GREEN_MS / 1000} s reached`;
    if (this.phaseCount(current) === 0) return `Gap-out: no demand on ${current}`;
    const sq = this.phaseScore(q);
    const sp = this.phaseScore(current);
    if (sq >= 2 * sp) return `Weighted demand ${q} ${sq} ≥ 2× ${current} ${sp}`;
    return null;
  }

  /** One deterministic engine step. */
  tick() {
    const s = this.s;
    const now = this.now();

    // 1) deliver emulated controller messages that are due
    const due = s.deviceQueue.filter((q) => q.at <= now);
    s.deviceQueue = s.deviceQueue.filter((q) => q.at > now);
    for (const q of due) {
      if (!s.device.online) continue;
      if (q.apply) s.device.deviceSignals = { ...q.apply };
      this.handleControllerEvent({ ...q.event, junction_id: "A", controller_id: "CTRL-A-EMU" }, false);
    }

    // 2) heartbeat from emulated controller
    if (s.device.online && now - s.lastHeartbeatSent >= SIM.HEARTBEAT_MS) {
      s.lastHeartbeatSent = now;
      this.handleControllerEvent({ event_type: "HEARTBEAT", junction_id: "A", controller_id: "CTRL-A-EMU", reported_signals: { ...s.device.deviceSignals } }, false);
    }

    // 3) startup: ask for a snapshot once
    if (s.stage === "STARTUP_RECONCILIATION" && s.trust !== "CONFIRMED" && !s.snapshotRequested && s.device.online) {
      s.snapshotRequested = true;
      this.schedule(400, { event_type: "SNAPSHOT", reported_signals: { ...s.device.deviceSignals } });
    }

    // 4) safety watchdogs
    if (s.stage !== "FAULT_LOCKOUT" && now - s.lastContact > SIM.STALE_AFTER_MS) {
      this.fault("HEARTBEAT_LOST", "STALE", "No controller heartbeat for > 3 s");
    }
    if (s.pending && now >= Date.parse(s.pending.ack_deadline)) {
      this.fault("ACK_TIMEOUT", "UNKNOWN", `No ACK for ${s.pending.command_id} within 3 s`);
    }

    // 5) manual lease expiry
    if (s.manual && now >= Date.parse(s.manual.lease_expires_at)) {
      this.log("MANUAL", "MANUAL_LEASE_EXPIRED", { direction: s.manual.direction, decision: "120 s lease expired; automatic scheduling resumes" });
      s.manual = null;
    }

    this.refreshDerived();
    if (s.stage === "FAULT_LOCKOUT" || s.pending || s.trust !== "CONFIRMED") return;

    // 6) simulated departures during a confirmed green
    if (s.device.autoFlow && s.phase && s.stage.endsWith("_GREEN") && now - s.lastDepartureAt >= SIM.DEPARTURE_EVERY_MS) {
      s.lastDepartureAt = now;
      for (const d of PHASE_DIRECTIONS[s.phase]) {
        const v = s.vehicles.filter((x) => x.direction === d).sort((a, b) => a.arrived_at - b.arrived_at)[0];
        if (v) this.ingestInternal("VEHICLE_CLEARED", d, v.vehicle_id, v.vehicle_type, "Simulated departure on confirmed green");
      }
      this.refreshDerived();
    }

    // 7) scheduling (only when no command is awaiting ACK)
    switch (s.stage) {
      case "STARTUP_RECONCILIATION": {
        const greenPhase = (["NORTH_SOUTH", "EAST_WEST"] as Phase[]).find((p) => PHASE_DIRECTIONS[p].some((d) => s.actual[d] === "GREEN"));
        if (greenPhase) this.issueCommand(yellowFor(greenPhase), { kind: "YELLOW", from: greenPhase }, `Reconciliation: ${greenPhase} found green — clearing via YELLOW`);
        else this.issueCommand(ALL_RED_VECTOR, { kind: "ALL_RED" }, "Reconciliation: request full-junction ALL RED");
        break;
      }
      case "NORTH_SOUTH_GREEN":
      case "EAST_WEST_GREEN": {
        const current = s.stage === "NORTH_SOUTH_GREEN" ? "NORTH_SOUTH" : "EAST_WEST";
        const reason = this.decideSwitch(current);
        if (reason) {
          s.targetPhase = otherPhase(current);
          this.issueCommand(yellowFor(current), { kind: "YELLOW", from: current }, reason);
        } else {
          s.decision = `Holding ${current} green`;
        }
        break;
      }
      case "NORTH_SOUTH_YELLOW":
      case "EAST_WEST_YELLOW":
        if (s.stageDeadline && now >= s.stageDeadline) this.issueCommand(ALL_RED_VECTOR, { kind: "ALL_RED" }, "Yellow clearance (5 s) complete → full-junction ALL RED");
        break;
      case "ALL_RED":
        if (s.stageDeadline && now >= s.stageDeadline) {
          const t = this.chooseTarget();
          s.targetPhase = t.phase;
          this.issueCommand(greenFor(t.phase), { kind: "GREEN", to: t.phase }, `All-red (2 s) complete → ${t.phase} GREEN · ${t.reason}`);
        }
        break;
    }
  }

  private snapshot(): JunctionStatus {
    const s = this.s;
    const now = this.now();
    const by_direction: Partial<Record<Direction, DirectionQueue>> = {};
    for (const d of DIRECTIONS) {
      const list = s.vehicles.filter((v) => v.direction === d).sort((a, b) => a.arrived_at - b.arrived_at);
      const by_type: Partial<Record<VehicleType, number>> = {};
      list.forEach((v) => (by_type[v.vehicle_type] = (by_type[v.vehicle_type] ?? 0) + 1));
      by_direction[d] = {
        direction: d,
        count: list.length,
        by_type,
        oldest_wait_seconds: list.length ? this.waitS(list[0], now) : null,
        vehicles: list.map((v) => ({ vehicle_id: v.vehicle_id, vehicle_type: v.vehicle_type, arrived_at: new Date(v.arrived_at).toISOString(), wait_seconds: this.waitS(v, now) })),
      };
    }
    const actual = sanitizeObserved(s.actual);
    return {
      junction_id: "A",
      name: JUNCTIONS[0].name,
      mode: s.mode,
      stage: s.stage,
      phase: s.phase,
      target_phase: s.targetPhase,
      controller_status: s.controllerStatus,
      physical_state_trust: s.trust,
      desired_signals: { ...s.desired },
      actual_signals: actual,
      actual_observed_at: this.iso(s.actualObservedAt),
      stage_started_at: this.iso(s.stageStartedAt),
      stage_deadline: this.iso(s.stageDeadline),
      queues: {
        total_waiting: s.vehicles.length,
        by_direction,
        phase_scores: { NORTH_SOUTH: this.phaseScore("NORTH_SOUTH"), EAST_WEST: this.phaseScore("EAST_WEST") },
        starving_phase: this.starvingPhase(),
      },
      pending_command: s.pending ? clone(s.pending) : null,
      recent_commands: s.commands.slice(0, 12).map(clone),
      manual_request: s.manual ? { ...s.manual } : null,
      emergency: this.emergency(),
      alerts: s.alerts.map((a) => ({ ...a })),
      decision_reason: s.decision,
      last_sequence_by_direction: { ...s.lastSeq },
      server_time: new Date(now).toISOString(),
    };
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function fmtVec(v: Partial<ObservedSignalVector>) {
  return DIRECTIONS.map((d) => `${d[0]}:${(v[d] ?? "?")[0]}`).join(" ");
}
