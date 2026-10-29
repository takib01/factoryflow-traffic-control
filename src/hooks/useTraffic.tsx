import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { getMockService, getTrafficService, type DataSource } from "@/services";
import { resolveApiBaseUrl } from "@/services/trafficApi";
import { resetSequences } from "@/lib/sensorEvents";
import type { ControllerEventRequest, ManualCommandRequest, SensorEventRequest } from "@/types/traffic";

interface TrafficCtx {
  source: DataSource;
  setSource: (s: DataSource) => void;
  junctionId: string;
  setJunctionId: (id: string) => void;
  apiBaseUrl: string;
  resetDemo: () => void;
}

const Ctx = createContext<TrafficCtx | null>(null);
const STORAGE_KEY = "factoryflow.dataSource";

export function TrafficProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [source, setSourceState] = useState<DataSource>("DEMO");
  const [junctionId, setJunctionId] = useState("A");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "LIVE" || saved === "DEMO") setSourceState(saved);
  }, []);

  const setSource = useCallback(
    (s: DataSource) => {
      setSourceState(s);
      window.localStorage.setItem(STORAGE_KEY, s);
      qc.removeQueries();
    },
    [qc],
  );

  const resetDemo = useCallback(() => {
    getMockService().reset();
    resetSequences("DEMO");
    qc.invalidateQueries();
    toast.success("Demo reset", { description: "Mock engine restarted with startup reconciliation." });
  }, [qc]);

  const value = useMemo(
    () => ({ source, setSource, junctionId, setJunctionId, apiBaseUrl: resolveApiBaseUrl(), resetDemo }),
    [source, setSource, junctionId, resetDemo],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTrafficContext() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTrafficContext must be used within TrafficProvider");
  return c;
}

/** Service resolver — called lazily inside query/mutation functions (browser only). */
export function useService() {
  const { source } = useTrafficContext();
  return useCallback(() => getTrafficService(source), [source]);
}

export function useJunctionStatus() {
  const { source, junctionId } = useTrafficContext();
  return useQuery({
    queryKey: ["status", source, junctionId],
    queryFn: () => getTrafficService(source).getStatus(junctionId),
    refetchInterval: 1000,
    retry: source === "LIVE" ? 0 : 1,
    staleTime: 0,
  });
}

export function useJunctionHistory(limit = 200) {
  const { source, junctionId } = useTrafficContext();
  return useQuery({
    queryKey: ["history", source, junctionId, limit],
    queryFn: () => getTrafficService(source).getHistory(junctionId, { limit }),
    refetchInterval: 3000,
    retry: source === "LIVE" ? 0 : 1,
  });
}

export function useJunctions() {
  const { source } = useTrafficContext();
  return useQuery({
    queryKey: ["junctions", source],
    queryFn: () => getTrafficService(source).listJunctions(),
    retry: 0,
    refetchInterval: source === "LIVE" ? 10_000 : false,
  });
}

/** DEMO-only controller emulator settings. */
export function useEmulator() {
  const { source } = useTrafficContext();
  return useQuery({
    queryKey: ["emulator", source],
    queryFn: () => getMockService().getEmulator(),
    enabled: source === "DEMO",
    refetchInterval: 1000,
  });
}

export function useRefreshAll() {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ["status"] });
    qc.invalidateQueries({ queryKey: ["history"] });
    qc.invalidateQueries({ queryKey: ["emulator"] });
  }, [qc]);
}

function errorToast(err: unknown) {
  toast.error("Request failed", { description: err instanceof Error ? err.message : String(err) });
}

export function useSensorEventMutation() {
  const svc = useService();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (evt: SensorEventRequest) => svc().postSensorEvent(evt),
    onSuccess: refresh,
    onError: errorToast,
  });
}

export function useManualCommandMutation() {
  const svc = useService();
  const { junctionId } = useTrafficContext();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (cmd: ManualCommandRequest) => svc().postManualCommand(junctionId, cmd),
    onSuccess: refresh,
    onError: errorToast,
  });
}

export function useControllerEventMutation() {
  const svc = useService();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (evt: ControllerEventRequest) => svc().postControllerEvent(evt),
    onSuccess: refresh,
    onError: errorToast,
  });
}

/** Re-renders at the given interval for display-only countdowns. Never drives state. */
export function useNow(intervalMs = 250) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
