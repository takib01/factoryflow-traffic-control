import type { TrafficService } from "./trafficApi";
import type { MockTrafficService } from "./mockTrafficService";
import { buildSensorEvent, newId, suggestVehicleId } from "@/lib/sensorEvents";
import type {
  Direction,
  JunctionStatus,
  SensorEventRequest,
  SensorEventResult,
  SensorEventType,
  VehicleType,
} from "@/types/traffic";

/**
 * Scripted "Simulated demo" scenarios. They only talk to the service through the
 * public TrafficService API (plus the mock-only emulator in DEMO mode), so the
 * resulting state and history come from the service, never from the UI.
 */
export interface ScenarioContext {
  service: TrafficService;
  mock: MockTrafficService | null;
  junctionId: string;
  source: string;
  status?: JunctionStatus;
}

export interface ScenarioOutcome {
  ok: boolean;
  summary: string;
}

export type ScenarioId =
  | "normal"
  | "priority_truck"
  | "emergency"
  | "manual"
  | "duplicate"
  | "controller_failure"
  | "recovery"
  | "burst";

export interface ScenarioDef {
  id: ScenarioId;
  name: string;
  description: string;
  disruptive?: boolean;
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>;
}

function make(ctx: ScenarioContext, type: SensorEventType, direction: Direction, vehicleType: VehicleType, vehicleId?: string) {
  return buildSensorEvent({
    source: ctx.source,
    junctionId: ctx.junctionId,
    type,
    direction,
    vehicleId: vehicleId ?? suggestVehicleId(vehicleType),
    vehicleType,
    serverLastSeq: ctx.status?.last_sequence_by_direction?.[direction],
  });
}

async function arrivals(ctx: ScenarioContext, list: Array<[Direction, VehicleType]>) {
  const results: SensorEventResult[] = [];
  for (const [d, t] of list) results.push(await ctx.service.postSensorEvent(make(ctx, "VEHICLE_ARRIVED", d, t)));
  return results;
}

const count = (rs: SensorEventResult[], r: SensorEventResult["result"]) => rs.filter((x) => x.result === r).length;

function oppositeDirection(status?: JunctionStatus): Direction {
  return status?.phase === "NORTH_SOUTH" || status?.stage?.startsWith("NORTH_SOUTH") ? "EAST" : "NORTH";
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "normal",
    name: "Normal Traffic",
    description: "Six mixed employee/forklift arrivals across all approaches.",
    async run(ctx) {
      const rs = await arrivals(ctx, [
        ["NORTH", "EMPLOYEE_VEHICLE"],
        ["SOUTH", "FORKLIFT"],
        ["EAST", "EMPLOYEE_VEHICLE"],
        ["WEST", "FORKLIFT"],
        ["NORTH", "EMPLOYEE_VEHICLE"],
        ["SOUTH", "EMPLOYEE_VEHICLE"],
      ]);
      return { ok: true, summary: `${count(rs, "accepted")} arrivals accepted; scheduler balances phases by weighted demand.` };
    },
  },
  {
    id: "priority_truck",
    name: "Priority Truck",
    description: "Two trucks (weight 4) on E/W against light N/S demand.",
    async run(ctx) {
      const rs = await arrivals(ctx, [
        ["NORTH", "EMPLOYEE_VEHICLE"],
        ["WEST", "TRUCK"],
        ["EAST", "TRUCK"],
      ]);
      return { ok: true, summary: `${count(rs, "accepted")} accepted. E/W weighted score rises; switch only after minimum green and a safe transition.` };
    },
  },
  {
    id: "emergency",
    name: "Emergency Preemption",
    description: "Emergency vehicle arrives at EAST; next safely achievable phase becomes E/W.",
    async run(ctx) {
      const r = await ctx.service.postSensorEvent(make(ctx, "VEHICLE_ARRIVED", "EAST", "EMERGENCY", `EMG-${Math.floor(100 + Math.random() * 900)}`));
      return { ok: r.result === "accepted", summary: `${r.result.toUpperCase()}: emergency at EAST. Conflicting green is never cut instantly — YELLOW → ALL RED first.` };
    },
  },
  {
    id: "manual",
    name: "Manual Override",
    description: "Operator requests green for the opposing phase (120 s lease).",
    async run(ctx) {
      const direction = oppositeDirection(ctx.status);
      const r = await ctx.service.postManualCommand(ctx.junctionId, { request_id: newId("req"), command: "MANUAL_GREEN_REQUEST", direction });
      return { ok: r.result === "accepted", summary: `${direction}: ${r.message}` };
    },
  },
  {
    id: "duplicate",
    name: "Duplicate Event",
    description: "Same sensor event_id delivered three times — applied once.",
    async run(ctx) {
      const evt: SensorEventRequest = make(ctx, "VEHICLE_ARRIVED", "SOUTH", "FORKLIFT");
      const rs = [await ctx.service.postSensorEvent(evt), await ctx.service.postSensorEvent(evt), await ctx.service.postSensorEvent(evt)];
      return { ok: true, summary: `${evt.vehicle_id}: ${rs.map((r) => r.result).join(" → ")}. Queue incremented once.` };
    },
  },
  {
    id: "controller_failure",
    name: "Controller Failure",
    description: "Controller drops ACKs while a transition is requested → FAULT_LOCKOUT after 3 s.",
    disruptive: true,
    async run(ctx) {
      if (ctx.mock) {
        ctx.mock.setEmulator({ ackMode: "DROP_ACK" });
        const direction = oppositeDirection(ctx.status);
        await ctx.service.postManualCommand(ctx.junctionId, { request_id: newId("req"), command: "MANUAL_GREEN_REQUEST", direction });
        return { ok: true, summary: "Emulator now drops ACKs. Watch the pending command time out and lamps go UNKNOWN." };
      }
      const r = await ctx.service.postControllerEvent({
        event_id: newId("ctl"),
        junction_id: ctx.junctionId,
        controller_id: "CTRL-A",
        event_type: "CONTROLLER_OFFLINE",
        observed_at: new Date().toISOString(),
      });
      return { ok: r.result === "accepted", summary: `CONTROLLER_OFFLINE posted: ${r.message}` };
    },
  },
  {
    id: "recovery",
    name: "Recovery",
    description: "Restore controller link, AUTO_ACK, then reconcile from a fresh snapshot.",
    async run(ctx) {
      if (ctx.mock) {
        ctx.mock.setEmulator({ online: true, ackMode: "AUTO_ACK" });
        const r = ctx.mock.requestSnapshot();
        return { ok: r.ok, summary: `${r.message} Safe stop (ALL RED) precedes any green.` };
      }
      const now = new Date().toISOString();
      await ctx.service.postControllerEvent({ event_id: newId("ctl"), junction_id: ctx.junctionId, controller_id: "CTRL-A", event_type: "CONTROLLER_ONLINE", observed_at: now });
      const r = await ctx.service.postControllerEvent({
        event_id: newId("ctl"),
        junction_id: ctx.junctionId,
        controller_id: "CTRL-A",
        event_type: "SNAPSHOT",
        reported_signals: { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" },
        observed_at: now,
      });
      return { ok: r.result === "accepted", summary: `Snapshot posted: ${r.message}` };
    },
  },
  {
    id: "burst",
    name: "Concurrent Event Burst",
    description: "10 events fired in parallel incl. duplicates and a stale sequence.",
    async run(ctx) {
      const base = [
        make(ctx, "VEHICLE_ARRIVED", "NORTH", "EMPLOYEE_VEHICLE"),
        make(ctx, "VEHICLE_ARRIVED", "EAST", "FORKLIFT"),
        make(ctx, "VEHICLE_ARRIVED", "SOUTH", "TRUCK"),
        make(ctx, "VEHICLE_ARRIVED", "WEST", "EMPLOYEE_VEHICLE"),
        make(ctx, "VEHICLE_ARRIVED", "NORTH", "FORKLIFT"),
        make(ctx, "VEHICLE_ARRIVED", "EAST", "EMPLOYEE_VEHICLE"),
      ];
      const stale: SensorEventRequest = { ...make(ctx, "VEHICLE_ARRIVED", "NORTH", "EMPLOYEE_VEHICLE"), sequence_no: base[0].sequence_no };
      const clearFirst = make(ctx, "VEHICLE_CLEARED", "WEST", "EMPLOYEE_VEHICLE", base[3].vehicle_id);
      const all = [...base, base[0], base[1], stale, clearFirst];
      const rs = await Promise.all(all.map((e) => ctx.service.postSensorEvent(e)));
      return {
        ok: true,
        summary: `Serialized ${rs.length}: ${count(rs, "accepted")} accepted · ${count(rs, "duplicate")} duplicate · ${count(rs, "stale")} stale · ${count(rs, "rejected")} rejected.`,
      };
    },
  },
];
