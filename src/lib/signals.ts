import {
  DIRECTIONS,
  PHASE_DIRECTIONS,
  type Direction,
  type JunctionStatus,
  type LampColor,
  type ObservedLamp,
  type ObservedSignalVector,
  type Phase,
  type SignalVector,
} from "@/types/traffic";

/** Pure vector helpers + a display-only safety guard. No scheduling logic lives here. */

export function uniformVector(color: LampColor): SignalVector {
  return { NORTH: color, EAST: color, SOUTH: color, WEST: color };
}

export const ALL_RED_VECTOR: SignalVector = uniformVector("RED");
export const UNKNOWN_VECTOR: ObservedSignalVector = {
  NORTH: "UNKNOWN",
  EAST: "UNKNOWN",
  SOUTH: "UNKNOWN",
  WEST: "UNKNOWN",
};

export function phaseVector(phase: Phase, color: LampColor): SignalVector {
  const v = uniformVector("RED");
  for (const d of PHASE_DIRECTIONS[phase]) v[d] = color;
  return v;
}

export function vectorsEqual(a: ObservedSignalVector, b: ObservedSignalVector): boolean {
  return DIRECTIONS.every((d) => a[d] === b[d]);
}

const isMoving = (c: ObservedLamp) => c === "GREEN" || c === "YELLOW";

/** True when N/S and E/W would both be released (green/yellow) at the same time. */
export function hasConflict(v: Partial<ObservedSignalVector> | null | undefined): boolean {
  if (!v) return false;
  const ns = isMoving(v.NORTH ?? "RED") || isMoving(v.SOUTH ?? "RED");
  const ew = isMoving(v.EAST ?? "RED") || isMoving(v.WEST ?? "RED");
  return ns && ew;
}

/** Any conflicting report is treated as fully unknown — it must never render as green. */
export function sanitizeObserved(v: Partial<ObservedSignalVector> | null | undefined): ObservedSignalVector {
  if (!v || hasConflict(v)) return { ...UNKNOWN_VECTOR };
  const out = { ...UNKNOWN_VECTOR };
  for (const d of DIRECTIONS) {
    const c = v[d];
    out[d] = c === "RED" || c === "YELLOW" || c === "GREEN" ? c : "UNKNOWN";
  }
  return out;
}

export interface DisplayLamp {
  color: LampColor | null;
  verified: boolean;
}

/**
 * Lamp the UI may render as lit. Only controller-confirmed, non-conflicting
 * actual state is shown; anything else is rendered as an unverified "?".
 * Desired signals are never used here.
 */
export function displayedLamp(status: JunctionStatus | undefined, direction: Direction): DisplayLamp {
  if (!status) return { color: null, verified: false };
  if (status.physical_state_trust !== "CONFIRMED") return { color: null, verified: false };
  const actual = sanitizeObserved(status.actual_signals);
  const c = actual[direction];
  if (c === "UNKNOWN") return { color: null, verified: false };
  return { color: c, verified: true };
}

export function mismatchedDirections(status: JunctionStatus | undefined): Direction[] {
  if (!status) return [];
  const actual = sanitizeObserved(status.actual_signals);
  return DIRECTIONS.filter((d) => status.desired_signals?.[d] !== actual[d]);
}
