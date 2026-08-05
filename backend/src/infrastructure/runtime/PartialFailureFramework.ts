export type ComponentHealthState = 'OK' | 'DEGRADED' | 'FAILED';

export interface ComponentStatus {
  readonly state: ComponentHealthState;
  readonly reason?: string;
  readonly updatedAt: number;
}

export class PartialResultContainer<TData extends object> {
  private statusMap = new Map<string, ComponentStatus>();

  constructor(public readonly data: Partial<TData> = {}) {}

  public setComponentStatus(componentName: keyof TData & string, state: ComponentHealthState, reason?: string): void {
    this.statusMap.set(componentName, {
      state,
      reason,
      updatedAt: Date.now(),
    });
  }

  public setComponentData<K extends keyof TData & string>(componentName: K, value: TData[K]): void {
    (this.data as any)[componentName] = value;
    this.setComponentStatus(componentName, 'OK');
  }

  public getComponentStatus(componentName: keyof TData & string): ComponentStatus {
    return this.statusMap.get(componentName) || { state: 'OK', updatedAt: Date.now() };
  }

  public hasFailures(): boolean {
    for (const status of this.statusMap.values()) {
      if (status.state === 'FAILED' || status.state === 'DEGRADED') {
        return true;
      }
    }
    return false;
  }

  public toSummary(): { isDegraded: boolean; components: Record<string, ComponentStatus> } {
    const componentsObj: Record<string, ComponentStatus> = {};
    for (const [k, v] of this.statusMap.entries()) {
      componentsObj[k] = v;
    }
    return {
      isDegraded: this.hasFailures(),
      components: componentsObj,
    };
  }
}
