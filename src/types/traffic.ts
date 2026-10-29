/**
 * Shared domain types for FactoryFlow | Traffic Control.
 *
 * The shapes mirror the REST contract of the separate Node.js + Express
 * backend (GET /api/junctions/:id/status etc.). Optional fields may be
 * absent in real backend responses — every consumer must tolerate that.
 */

export const DIRECTIONS = ["NORTH", "EAST", "SOUTH", "WEST"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const PHASES = ["NORTH_SOUTH", "EAST_WEST"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_DIRECTIONS: Record<Phase, readonly [Direction, Direction]> = {
  NORTH_SOUTH: ["NORTH", "SOUTH"],
  EAST_WEST: ["EAST", "WEST"],
};

export function phaseOf(direction: Direction): Phase {
  return direction === "NORTH" || direction === "SOUTH" ? "NORTH_SOUTH" : "EAST_WEST";
}

export function otherPhase(phase: Phase): Phase {
  return phase === "NORTH_SOUTH" ? "EAST_WEST" : "NORTH_SOUTH";
}

export type LampColor = "RED" | "YELLOW" | "GREEN";
/** Controller-reported lamp; UNKNOWN when the physical state cannot be trusted. */
export type ObservedLamp = LampColor | "UNKNOWN";

export type SignalVector = Record<Direction, LampColor>;
export type ObservedSignalVector = Record<Direction, ObservedLamp>;

export type OperatingMode = "AUTOMATIC" | "MANUAL" | "EMERGENCY" | "DEGRADED";

export type Stage =
  | "ALL_RED"
  | "NORTH_SOUTH_GREEN"
  | "NORTH_SOUTH_YELLOW"
  | "EAST_WEST_GREEN"
  | "EAST_WEST_YELLOW"
  | "STARTUP_RECONCILIATION"
  | "FAULT_LOCKOUT";

export type ControllerStatus = "ONLINE" | "OFFLINE" | "DEGRADED";
export type PhysicalStateTrust = "CONFIRMED" | "STALE" | "UNKNOWN" | "MISMATCH";

export const VEHICLE_TYPES = ["EMPLOYEE_VEHICLE", "FORKLIFT", "TRUCK", "EMERGENCY"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export interface QueuedVehicle {
  vehicle_id: string;
  vehicle_type: VehicleType;
  arrived_at: string;
  wait_seconds?: number;
}

export interface DirectionQueue {
  direction: Direction;
  count: number;
  by_type: Partial<Record<VehicleType, number>>;
  oldest_wait_seconds?: number | null;
  vehicles?: QueuedVehicle[];
}

export interface QueueSummary {
  total_waiting: number;
  by_direction: Partial<Record<Direction, DirectionQueue>>;
  /** Weighted demand per phase, only when the service supplies it. */
  phase_scores?: Partial<Record<Phase, number>>;
  starving_phase?: Phase | null;
}

export type CommandStatus = "PENDING" | "ACKED" | "TIMED_OUT" | "MISMATCH" | "SUPERSEDED";

export interface ControllerCommand {
  command_id: string;
  command_type: "SET_SIGNALS";
  expected_signals: SignalVector;
  acknowledged_signals?: ObservedSignalVector | null;
  status: CommandStatus;
  issued_at: string;
  ack_deadline: string;
  acked_at?: string | null;
  reason?: string;
}

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface Alert {
  alert_id: string;
  code: string;
  severity: AlertSeverity;
  message: string;
  raised_at: string;
}

export interface ManualRequest {
  request_id: string;
  direction: Direction;
  phase: Phase;
  requested_at: string;
  lease_expires_at: string;
  suspended_by_emergency?: boolean;
}

export interface EmergencyInfo {
  vehicle_id: string;
  direction: Direction;
  phase: Phase;
  since: string;
}

export interface JunctionSummary {
  junction_id: string;
  name: string;
  location?: string;
  directions?: Direction[];
}

/** Mirrors GET /api/junctions/:id/status */
export interface JunctionStatus {
  junction_id: string;
  name?: string;
  mode: OperatingMode;
  stage: Stage;
  /** Phase currently being served (null in ALL_RED / lockout). */
  phase: Phase | null;
  target_phase?: Phase | null;
  controller_status: ControllerStatus;
  physical_state_trust: PhysicalStateTrust;
  desired_signals: SignalVector;
  actual_signals: ObservedSignalVector;
  actual_observed_at?: string | null;
  stage_started_at?: string | null;
  stage_deadline?: string | null;
  queues: QueueSummary;
  pending_command?: ControllerCommand | null;
  recent_commands?: ControllerCommand[];
  manual_request?: ManualRequest | null;
  emergency?: EmergencyInfo | null;
  alerts: Alert[];
  decision_reason?: string | null;
  last_sequence_by_direction?: Partial<Record<Direction, number>>;
  server_time?: string;
}

export type AuditCategory = "VEHICLE" | "MANUAL" | "EMERGENCY" | "CONTROLLER" | "FAULT" | "SYSTEM";

export interface AuditEvent {
  id: string;
  timestamp: string;
  category: AuditCategory;
  event_type: string;
  direction?: Direction | null;
  vehicle_id?: string | null;
  vehicle_type?: VehicleType | null;
  stage?: Stage | null;
  mode?: OperatingMode | null;
  correlation_id?: string | null;
  decision?: string | null;
  result?: string | null;
}

export type SensorEventType = "VEHICLE_ARRIVED" | "VEHICLE_CLEARED";

/** POST /api/sensor-events */
export interface SensorEventRequest {
  event_id: string;
  junction_id: string;
  event_type: SensorEventType;
  direction: Direction;
  vehicle_id: string;
  vehicle_type?: VehicleType;
  sequence_no: number;
  occurred_at: string;
}

export type IngestResult = "accepted" | "duplicate" | "stale" | "rejected";

export interface SensorEventResult {
  result: IngestResult;
  http_status: number;
  event_id: string;
  correlation_id: string;
  message: string;
}

/** POST /api/junctions/:id/commands */
export type ManualCommandRequest =
  | { request_id: string; command: "MANUAL_GREEN_REQUEST"; direction: Direction; operator?: string }
  | { request_id: string; command: "RETURN_TO_AUTOMATIC"; operator?: string };

export interface CommandResult {
  result: "accepted" | "rejected" | "duplicate";
  http_status: number;
  request_id: string;
  correlation_id: string;
  message: string;
  manual_request?: ManualRequest | null;
}

export type ControllerEventType =
  | "HEARTBEAT"
  | "SNAPSHOT"
  | "COMMAND_ACK"
  | "CONTROLLER_ONLINE"
  | "CONTROLLER_OFFLINE";

/** POST /api/controller-events */
export interface ControllerEventRequest {
  event_id: string;
  junction_id: string;
  controller_id: string;
  event_type: ControllerEventType;
  command_id?: string;
  reported_signals?: ObservedSignalVector;
  observed_at: string;
}

export interface ControllerEventResult {
  result: "accepted" | "ignored" | "rejected";
  http_status: number;
  event_id: string;
  correlation_id: string;
  message: string;
}

export interface HistoryQuery {
  limit?: number;
}
