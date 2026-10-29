import type { Direction, SensorEventRequest, SensorEventType, VehicleType } from "@/types/traffic";

/**
 * Client-side sensor event factory: unique event_id and a monotonically
 * increasing sequence_no per direction (and per data source).
 * The service remains the authority on accepting/rejecting them.
 */
type Counters = Record<Direction, number>;
const fresh = (): Counters => ({ NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 });
const counters: Record<string, Counters> = {};

export function nextSequence(source: string, direction: Direction, serverLast?: number): number {
  const c = (counters[source] ??= fresh());
  const next = Math.max(c[direction], serverLast ?? 0) + 1;
  c[direction] = next;
  return next;
}

export function resetSequences(source: string) {
  counters[source] = fresh();
}

export function newId(prefix: string): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export function buildSensorEvent(args: {
  source: string;
  junctionId: string;
  type: SensorEventType;
  direction: Direction;
  vehicleId: string;
  vehicleType?: VehicleType;
  serverLastSeq?: number;
}): SensorEventRequest {
  return {
    event_id: newId("evt"),
    junction_id: args.junctionId,
    event_type: args.type,
    direction: args.direction,
    vehicle_id: args.vehicleId,
    vehicle_type: args.vehicleType,
    sequence_no: nextSequence(args.source, args.direction, args.serverLastSeq),
    occurred_at: new Date().toISOString(),
  };
}

const PREFIX: Record<VehicleType, string> = {
  EMPLOYEE_VEHICLE: "EMP",
  FORKLIFT: "FLT",
  TRUCK: "TRK",
  EMERGENCY: "EMG",
};

export function suggestVehicleId(type: VehicleType): string {
  return `${PREFIX[type]}-${Math.floor(100 + Math.random() * 900)}`;
}
