import { HttpTrafficService, type TrafficService } from "./trafficApi";
import { MockTrafficService } from "./mockTrafficService";

export type DataSource = "DEMO" | "LIVE";

// Lazily created on first use in the browser (never at module evaluation / SSR).
let mock: MockTrafficService | null = null;
let http: HttpTrafficService | null = null;

export function getMockService(): MockTrafficService {
  if (!mock) mock = new MockTrafficService();
  return mock;
}

export function getHttpService(): HttpTrafficService {
  if (!http) http = new HttpTrafficService();
  return http;
}

export function getTrafficService(source: DataSource): TrafficService {
  return source === "DEMO" ? getMockService() : getHttpService();
}
