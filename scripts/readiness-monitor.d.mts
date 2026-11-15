export interface MonitorOptions {
  targetUrl?: string;
  webhookUrl?: string | null;
  intervalMs?: number;
  probeTimeoutMs?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
  maxDeliveryRetries?: number;
  deliveryRetryBackoffMs?: number;
  gatewayId?: string;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
  errorLogger?: (msg: string) => void;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
  durationMs: number;
}

export interface NotificationRecord {
  success: boolean;
  event: 'gateway_outage' | 'gateway_recovered';
  incidentId: string;
  timestamp: string;
  attempts?: number;
  error?: string;
}

export interface StepResult {
  state: 'HEALTHY' | 'DEGRADED' | 'OUTAGE';
  probeResult: ProbeResult;
  transition: string | null;
  delivery?: NotificationRecord;
}

export declare class ReadinessMonitor {
  targetUrl: string;
  webhookUrl: string | null;
  intervalMs: number;
  probeTimeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  maxDeliveryRetries: number;
  deliveryRetryBackoffMs: number;
  gatewayId: string;
  state: 'HEALTHY' | 'DEGRADED' | 'OUTAGE';
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  outageAlertDelivered: boolean;
  deliveryHistory: NotificationRecord[];

  constructor(options?: MonitorOptions);
  probe(): Promise<ProbeResult>;
  deliverNotification(payload: any): Promise<NotificationRecord>;
  step(): Promise<StepResult>;
  start(): void;
  stop(): void;
}
