import { describe, expect, it } from "vitest";
import { MockTrafficService } from "@/services/mockTrafficService";
import { hasConflict } from "@/lib/signals";
import type { SensorEventRequest } from "@/types/traffic";

function setup() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t };
  const svc = new MockTrafficService({ now: clock.now, autoTick: false, latencyMs: 0, seedVehicles: false });
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i += 50) {
      t += 50;
      svc.tick();
    }
  };
  return { svc, advance };
}

const arrive = (id: string, seq: number, over: Partial<SensorEventRequest> = {}): SensorEventRequest => ({
  event_id: id,
  junction_id: "A",
  event_type: "VEHICLE_ARRIVED",
  direction: "NORTH",
  vehicle_id: `V-${id}`,
  vehicle_type: "EMPLOYEE_VEHICLE",
  sequence_no: seq,
  occurred_at: new Date().toISOString(),
  ...over,
});

describe("mock traffic engine", () => {
  it("repeating the same event_id does not double-increment the queue", async () => {
    const { svc } = setup();
    const evt = arrive("e1", 1);
    expect((await svc.postSensorEvent(evt)).result).toBe("accepted");
    expect((await svc.postSensorEvent(evt)).result).toBe("duplicate");
    const st = await svc.getStatus("A");
    expect(st.queues.by_direction.NORTH?.count).toBe(1);
  });

  it("clearing a vehicle decrements at most once and never goes negative", async () => {
    const { svc } = setup();
    await svc.postSensorEvent(arrive("a1", 1, { vehicle_id: "T1" }));
    const clear = { ...arrive("c1", 2, { vehicle_id: "T1" }), event_type: "VEHICLE_CLEARED" as const };
    expect((await svc.postSensorEvent(clear)).result).toBe("accepted");
    const again = { ...clear, event_id: "c2", sequence_no: 3 };
    expect((await svc.postSensorEvent(again)).result).toBe("rejected");
    expect((await svc.getStatus("A")).queues.by_direction.NORTH?.count).toBe(0);
  });

  it("rejects a stale sequence number per direction", async () => {
    const { svc } = setup();
    await svc.postSensorEvent(arrive("s1", 5));
    expect((await svc.postSensorEvent(arrive("s2", 4))).result).toBe("stale");
  });

  it("weights EMPLOYEE=1 FORKLIFT=2 TRUCK=4", async () => {
    const { svc } = setup();
    await svc.postSensorEvent(arrive("w1", 1, { direction: "NORTH", vehicle_type: "EMPLOYEE_VEHICLE" }));
    await svc.postSensorEvent(arrive("w2", 1, { direction: "SOUTH", vehicle_type: "FORKLIFT" }));
    await svc.postSensorEvent(arrive("w3", 1, { direction: "EAST", vehicle_type: "TRUCK" }));
    const st = await svc.getStatus("A");
    expect(st.queues.phase_scores?.NORTH_SOUTH).toBe(3);
    expect(st.queues.phase_scores?.EAST_WEST).toBe(4);
  });

  it("transitions NS→EW via YELLOW 5s and ALL_RED 2s, never with conflicting actual greens", async () => {
    const { svc, advance } = setup();
    await svc.postSensorEvent(arrive("n1", 1, { direction: "NORTH" }));
    advance(4_000);
    let st = await svc.getStatus("A");
    expect(st.stage).toBe("NORTH_SOUTH_GREEN");
    await svc.postManualCommand("A", { request_id: "r1", command: "MANUAL_GREEN_REQUEST", direction: "EAST" });
    const stages: string[] = [];
    for (let i = 0; i < 200; i++) {
      advance(50);
      st = await svc.getStatus("A");
      expect(hasConflict(st.actual_signals)).toBe(false);
      if (stages.at(-1) !== st.stage) stages.push(st.stage);
    }
    expect(stages).toEqual(["NORTH_SOUTH_GREEN", "NORTH_SOUTH_YELLOW", "ALL_RED", "EAST_WEST_GREEN"]);
  });

  it("missing ACK after 3 s yields FAULT_LOCKOUT with unknown actual state", async () => {
    const { svc, advance } = setup();
    advance(4_000);
    svc.setEmulator({ ackMode: "DROP_ACK" });
    await svc.postManualCommand("A", { request_id: "r2", command: "MANUAL_GREEN_REQUEST", direction: "EAST" });
    advance(3_200);
    const st = await svc.getStatus("A");
    expect(st.stage).toBe("FAULT_LOCKOUT");
    expect(st.mode).toBe("DEGRADED");
    expect(Object.values(st.actual_signals).every((c) => c === "UNKNOWN")).toBe(true);
  });

  it("emergency outranks an active manual lease", async () => {
    const { svc, advance } = setup();
    advance(4_000);
    svc.setEmulator({ autoFlow: false });
    await svc.postManualCommand("A", { request_id: "r3", command: "MANUAL_GREEN_REQUEST", direction: "NORTH" });
    await svc.postSensorEvent(arrive("em", 1, { direction: "EAST", vehicle_type: "EMERGENCY", vehicle_id: "AMB-1" }));
    advance(10_000);
    const st = await svc.getStatus("A");
    expect(st.mode).toBe("EMERGENCY");
    expect(st.stage).toBe("EAST_WEST_GREEN");
  });
});
