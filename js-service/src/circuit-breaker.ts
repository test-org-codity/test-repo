export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
  halfOpenMaxCalls: number;
  slidingWindowSize: number;
  failureRateThreshold: number;
}

export interface CircuitBreakerMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  rejectedCalls: number;
  stateTransitions: number;
  lastFailureTime: Date | null;
  lastSuccessTime: Date | null;
  averageResponseTimeMs: number;
}

export interface HealthInfo {
  name: string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  failureRate: number;
  metrics: CircuitBreakerMetrics;
  config: Partial<CircuitBreakerConfig>;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 30000,
  halfOpenMaxCalls: 3,
  slidingWindowSize: 10,
  failureRateThreshold: 0.5,
};

export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly name: string,
    public readonly remainingTimeMs: number
  ) {
    super(
      `Circuit breaker '${name}' is open. Retry after ${Math.round(remainingTimeMs)}ms`
    );
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private static registry = new Map<string, CircuitBreaker>();

  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private halfOpenCalls = 0;
  private openedAt: number | null = null;
  private slidingWindow: boolean[];
  private windowIndex = 0;
  private responseTimes: number[] = [];
  private readonly maxResponseTimes = 100;

  private metrics: CircuitBreakerMetrics = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    rejectedCalls: 0,
    stateTransitions: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    averageResponseTimeMs: 0,
  };

  private readonly config: CircuitBreakerConfig;

  constructor(
    public readonly name: string,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.slidingWindow = new Array(this.config.slidingWindowSize).fill(true);
  }

  static getOrCreate(
    name: string,
    config?: Partial<CircuitBreakerConfig>
  ): CircuitBreaker {
    if (!this.registry.has(name)) {
      this.registry.set(name, new CircuitBreaker(name, config));
    }
    return this.registry.get(name)!;
  }

  static getRegistry(): Map<string, CircuitBreaker> {
    return new Map(this.registry);
  }

  async execute<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    if (!this.allowRequest()) {
      this.metrics.rejectedCalls++;
      if (fallback) {
        return fallback();
      }
      const remaining = this.config.timeoutMs - (Date.now() - (this.openedAt ?? 0));
      throw new CircuitBreakerOpenError(this.name, Math.max(0, remaining));
    }

    const startTime = Date.now();
    this.metrics.totalCalls++;

    try {
      const result = await operation();
      const duration = Date.now() - startTime;
      this.recordSuccess(duration);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordFailure(duration);
      throw error;
    }
  }

  executeSync<T>(operation: () => T, fallback?: () => T): T {
    if (!this.allowRequest()) {
      this.metrics.rejectedCalls++;
      if (fallback) {
        return fallback();
      }
      const remaining = this.config.timeoutMs - (Date.now() - (this.openedAt ?? 0));
      throw new CircuitBreakerOpenError(this.name, Math.max(0, remaining));
    }

    const startTime = Date.now();
    this.metrics.totalCalls++;

    try {
      const result = operation();
      const duration = Date.now() - startTime;
      this.recordSuccess(duration);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordFailure(duration);
      throw error;
    }
  }

  getState(): CircuitState {
    if (this.state === CircuitState.OPEN && this.shouldAttemptReset()) {
      this.transitionTo(CircuitState.HALF_OPEN);
    }
    return this.state;
  }

  getHealthInfo(): HealthInfo {
    return {
      name: this.name,
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      failureRate: this.calculateFailureRate(),
      metrics: { ...this.metrics },
      config: {
        failureThreshold: this.config.failureThreshold,
        successThreshold: this.config.successThreshold,
        timeoutMs: this.config.timeoutMs,
      },
    };
  }

  private allowRequest(): boolean {
    const currentState = this.getState();

    switch (currentState) {
      case CircuitState.CLOSED:
        return true;
      case CircuitState.OPEN:
        return false;
      case CircuitState.HALF_OPEN:
        if (this.halfOpenCalls < this.config.halfOpenMaxCalls) {
          this.halfOpenCalls++;
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  private shouldAttemptReset(): boolean {
    if (this.openedAt === null) return false;
    return Date.now() - this.openedAt >= this.config.timeoutMs;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    this.state = newState;
    this.metrics.stateTransitions++;

    switch (newState) {
      case CircuitState.OPEN:
        this.openedAt = Date.now();
        break;
      case CircuitState.HALF_OPEN:
        this.halfOpenCalls = 0;
        this.successCount = 0;
        break;
      case CircuitState.CLOSED:
        this.failureCount = 0;
        this.successCount = 0;
        this.openedAt = null;
        this.slidingWindow.fill(true);
        this.windowIndex = 0;
        break;
    }
  }

  private recordSuccess(duration: number): void {
    this.metrics.successfulCalls++;
    this.metrics.lastSuccessTime = new Date();
    this.addResponseTime(duration);
    this.addToSlidingWindow(true);

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        this.successCount++;
        if (this.successCount >= this.config.successThreshold) {
          this.transitionTo(CircuitState.CLOSED);
        }
        break;
      case CircuitState.CLOSED:
        this.failureCount = Math.max(0, this.failureCount - 1);
        break;
    }
  }

  private recordFailure(duration: number): void {
    this.metrics.failedCalls++;
    this.metrics.lastFailureTime = new Date();
    this.addResponseTime(duration);
    this.addToSlidingWindow(false);

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        this.transitionTo(CircuitState.OPEN);
        break;
      case CircuitState.CLOSED:
        this.failureCount++;
        const failureRate = this.calculateFailureRate();

        if (
          this.failureCount >= this.config.failureThreshold ||
          failureRate >= this.config.failureRateThreshold
        ) {
          this.transitionTo(CircuitState.OPEN);
        }
        break;
    }
  }

  private addToSlidingWindow(success: boolean): void {
    this.slidingWindow[this.windowIndex] = success;
    this.windowIndex = (this.windowIndex + 1) % this.config.slidingWindowSize;
  }

  private calculateFailureRate(): number {
    const failures = this.slidingWindow.filter((s) => !s).length;
    return failures / this.slidingWindow.length;
  }

  private addResponseTime(duration: number): void {
    this.responseTimes.push(duration);
    if (this.responseTimes.length > this.maxResponseTimes) {
      this.responseTimes.shift();
    }
    this.metrics.averageResponseTimeMs =
      this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length;
  }
}

export interface AggregatedState {
  service: string;
  consensusState: CircuitState;
  totalNodes: number;
  healthScore: number;
  nodeStates: Record<string, CircuitState>;
}

export class DistributedCircuitBreakerClient {
  private breakers = new Map<string, CircuitBreaker>();
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly nodeId: string;

  constructor(
    private readonly coordinatorUrl: string,
    private readonly syncIntervalMs: number = 5000
  ) {
    this.nodeId = process.env.NODE_ID ?? `ts-${process.pid}`;
  }

  register(breaker: CircuitBreaker): void {
    this.breakers.set(breaker.name, breaker);
    this.sendRegistration(breaker).catch(() => { });
  }

  startSync(): void {
    if (this.syncInterval) return;

    this.syncInterval = setInterval(() => {
      this.synchronizeStates().catch(() => { });
    }, this.syncIntervalMs);
  }

  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  async getAggregatedState(serviceName: string): Promise<AggregatedState> {
    try {
      const response = await fetch(
        `${this.coordinatorUrl}/circuit-breakers/${serviceName}/aggregate`
      );
      return (await response.json()) as AggregatedState;
    } catch {
      return {
        service: serviceName,
        consensusState: CircuitState.CLOSED,
        totalNodes: 0,
        healthScore: 0,
        nodeStates: {},
      };
    }
  }

  private async sendRegistration(breaker: CircuitBreaker): Promise<void> {
    await fetch(`${this.coordinatorUrl}/circuit-breakers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: breaker.name,
        node_id: this.nodeId,
        failure_threshold: breaker.getHealthInfo().config.failureThreshold,
        success_threshold: breaker.getHealthInfo().config.successThreshold,
      }),
    });
  }

  private async synchronizeStates(): Promise<void> {
    for (const [name, breaker] of this.breakers) {
      await this.reportState(name, breaker).catch(() => { });
    }
  }

  private async reportState(name: string, breaker: CircuitBreaker): Promise<void> {
    await fetch(`${this.coordinatorUrl}/circuit-breakers/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: name,
        node_id: this.nodeId,
        state: breaker.getState(),
        timestamp: Date.now(),
        health_info: breaker.getHealthInfo(),
      }),
    });
  }
}

export function withCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  name: string,
  config?: Partial<CircuitBreakerConfig>
) {
  const breaker = CircuitBreaker.getOrCreate(name, config);

  return function decorator(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      return breaker.execute(() => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}
