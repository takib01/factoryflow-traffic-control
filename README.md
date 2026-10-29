# FactoryFlow Traffic Control

Build a HIGH-QUALITY, FUNCTIONAL, FRONTEND-ONLY React/Vite/TypeScript dashboard called "FactoryFlow | Traffic Control" for a Backend Developer Intern assessment: Factory Traffic Management System, based on these exact product/engineering decisions. Do not build a backend, provision a database, or add Supabase/auth. This app must run and be meaningfully interactive in DEMO/MOCK mode now, and be READY to connect later to a separate Node.js + Express + PostgreSQL/Prisma REST backend.

PURPOSE: Control and monitor internal factory junction traffic, with 4 directions NORTH, SOUTH, EAST, WEST, compatible phases NORTH_SOUTH or EAST_WEST. Traffic lights have RED/YELLOW/GREEN. Distinguish operating modes AUTOMATIC/MANUAL/EMERGENCY/DEGRADED, and stages ALL_RED, NORTH_SOUTH_GREEN/YELLOW, EAST_WEST_GREEN/YELLOW, STARTUP_RECONCILIATION, FAULT_LOCKOUT.

VISUAL DIRECTION: professional industrial operations control center, not a generic SaaS marketing landing page. Desktop-first yet responsive; polished calm dark slate/navy UI with precise typography, subtle panel borders, clear information hierarchy, mild cyan/slate accents, reserved RED/YELLOW/GREEN strictly for signal and severity semantics. Crisp dashboard with left navigation, top command bar, modular content and intuitive empty/loading/error states. Avoid noisy gradients, big emoji, and placeholder marketing content. Use Lucide icons, Tailwind and shadcn/ui, compact cards, accessible labels and keyboard-friendly controls. Create a convincing and immediately usable interface.

REQUIRED MAIN SCREEN: a complete Operations Overview for Junction A:
1. Header "Factory Traffic Control" and Junction A selector (only A seeded), mode badge, controller ONLINE/OFFLINE/DEGRADED, live/demo connection indicator, last refreshed, reset demo control.
2. KPI row: Waiting vehicles, Active phase, Current mode, Controller health, Alerts (or emergency indicator).
3. MAIN CENTRAL VISUAL: large polished TOP-DOWN FOUR-WAY INTERSECTION (north on top, east right, south bottom, west left) drawn cleanly in CSS/SVG; four directional signal stacks with lit RED/YELLOW/GREEN from ACTUAL CONFIRMED backend/simulator snapshot (never from mere desired). Show each incoming direction's queue count and vehicle type mix; use subtle lanes and road markings. Mark unknown/stale actual state as gray question mark/unverified instead of green. Include an explicit legend with Desired vs Controller-confirmed and a countdown/elapsed stage badge, clearly labeled as BACKEND-reported when real API mode.
4. Next to junction, compact Queue & Scheduling panel: N/S and E/W grouped counts, list by direction, badges for TRUCK/FORKLIFT/EMPLOYEE/EMERGENCY, oldest wait and derived weighted phase scores when supplied, with explanatory tooltip. Never use queued frontend values as authoritative in API mode.
5. Desired vs Actual Signal State panel: side-by-side vectors N,S,E,W; physical_state_trust CONFIRMED/STALE/UNKNOWN/MISMATCH; actual_observed_at, current phase/stage, pending command id/timeout, manual lease expiry if any. A clear WARNING whenever desired and actual mismatch or controller ACK is missing.

INTERACTION PANELS / TABS:
- "Junction Detail": expands the intersection, stage progression timeline (GREEN -> YELLOW 5s -> ALL RED 2s -> GREEN); controller command status/ACK and timestamp, alerts. Use stage information from service, do not compute real phase changes in UI.
- "Traffic Simulator": forms to simulate VEHICLE_ARRIVED and VEHICLE_CLEARED with direction dropdown, vehicle type (EMPLOYEE_VEHICLE/FORKLIFT/TRUCK/EMERGENCY) and vehicle ID; generate unique event_id and monotonically increasing sequence_no per direction in mock mode. Vehicle-clearance uses a select of actual active vehicles so it cannot accidentally clear a nonexistent vehicle; also allow invalid event demo as a distinctly labeled test. Show HTTP-like result (accepted, duplicate, stale, rejected) with toast and event correlation id. Buttons: Spawn vehicle, Clear vehicle, Repeat last event (demonstrate idempotency), Add emergency EAST, Reset demo.
- "Manual Control": four request buttons N/S/E/W that call POST /api/junctions/A/commands with MANUAL_GREEN_REQUEST and direction; separate RETURN_TO_AUTOMATIC button. Show current request/target, 120s manual lease and emergency-override precedence; ensure user is informed that pressing a direction requests a SAFE TRANSITION and does NOT immediately switch a lamp. Confirm disruptive demo actions where appropriate.
- "Controller Lab": emulate controller ONLINE/OFFLINE, AUTO_ACK, DELAY_ACK, DROP_ACK, MISMATCH_ACK modes, fresh snapshot/reconcile action and injectable delay. Expose command ID and expected/acknowledged vector. A missing ACK after 3 seconds must show DEGRADED/FAULT_LOCKOUT, unknown actual states, and never show conflicting actual greens.
- "Activity History": recent events timeline/table with timestamps, event type, direction, vehicle ID, stage/mode, correlation id, cause/decision info; filters for vehicle/manual/emergency/controller/fault, newest first; understandable tags.

Provide one-click SCENARIOS: Normal Traffic, Priority Truck, Emergency Preemption, Manual Override, Duplicate Event, Controller Failure, Recovery, Concurrent Event Burst. These must update mock service state and history, not be inert screenshots. Make scenario labels explicit "Simulated demo". A useful scripted demonstration is better than trying to fake complex real traffic policy.

NONNEGOTIABLE SAFETY AND BEHAVIOR:
- Conflicting N/S and E/W must never show GREEN together.
- Safe order when moving N/S to E/W: N/S confirmed GREEN -> request YELLOW, await ACK -> YELLOW for 5s from ACK -> request ALL_RED and await fresh full-junction ACK -> ALL_RED for 2s -> request E/W GREEN and await ACK. Same reverse.
- Controller ACK gated; desired signals and confirmed actual signals separate; device offline / unknown / delayed ACK MUST NEVER be rendered as confirmed green. SAFETY/FAULT > EMERGENCY > MANUAL > AUTOMATIC.
- Normal green approx 30 sec, auto minimum green 10 sec; queue priority weights EMPLOYEE=1 FORKLIFT=2 TRUCK=4, age bonus +1 per 15s capped 8, starvation at 90s. Treat these as documented simulation assumptions.
- Emergency changes next safely achievable target, never instantly jumps a conflicting green; manual request 2-minute lease and emergency outranks it.
- Repeating same event_id must not double-increment. Clearing vehicle decrements at most once; no negatives. Concurrent events serialized in mock service.
- This is ONLY A NON-PRODUCTION SIMULATOR UI; show a subtle "Simulation only — not connected to certified hardware" disclosure and do not pretend to guarantee actual road safety.
- In REAL/API mode traffic scheduling, transitions, ACKs and queue state are exclusively backend-owned: NEVER independently infer/advance backend signal state using React timers. Timers in frontend may only display elapsed/countdown based on returned deadlines.

ARCHITECTURE/API INTEGRATION:
- Use React, Vite, TypeScript, Tailwind, shadcn/ui, Lucide; React Query/polling desirable.
- Create src/types/traffic.ts with typed JunctionStatus, SignalVector, QueueSummary, Event/Audit, Alert, ControllerCommand, SensorEvent/requests. State shape mirrors GET /api/junctions/A/status: junction_id, mode, stage, phase, controller_status, physical_state_trust, desired_signals, actual_signals, queues, pending_command, alerts, actual_observed_at. Handle missing optional fields gracefully.
- Create clean src/services/trafficApi.ts with interface TrafficService and concrete HttpTrafficService using configurable VITE_API_BASE_URL (default http://localhost:3000/api), methods listJunctions, getStatus, getHistory, postSensorEvent, postManualCommand, postControllerEvent. Exactly these backend routes: GET /junctions; GET /junctions/:id; GET /junctions/:id/status; POST /sensor-events; POST /junctions/:id/commands; POST /controller-events; GET /junctions/:id/history.
- Create separate src/services/mockTrafficService.ts implementing same interface for standalone DEMO mode. Use a confined deterministic mock control engine and scripted transitions/ACK generation there — never mix these rules into visual React components or HttpTrafficService. Optionally localStorage-persist mock fixtures (label clearly as mock); provide reset.
- A simple mode toggle DEMO vs LIVE/API, default DEMO, show disconnected/connection errors clearly; API mode should not silently fall back to fake values. Poll status 1 second and history 3 seconds using React Query. Use meaningful loading, offline, invalid input, empty history, and error toasts.
- Components should be maintainable and reusable. Do not add external cloud dependencies. Include README describing how to run frontend and connect to real backend via env var and how simulation differs from real backend.
- Be visually exceptional AND functionally complete: every visible interactive button should do something meaningful, no empty placeholder pages.

PRIORITY: Build the full excellent dashboard and working demo simulation. Begin coding immediately.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ada4107c-9389-4f82-aecc-609f49a9ad92).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
