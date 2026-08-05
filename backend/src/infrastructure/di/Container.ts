export class Container {
  private services = new Map<string, unknown>();

  public register<T>(key: string, factory: (c: Container) => T): void {
    this.services.set(key, factory(this));
  }

  public registerInstance<T>(key: string, instance: T): void {
    this.services.set(key, instance);
  }

  public resolve<T>(key: string): T {
    const service = this.services.get(key);
    if (!service) {
      throw new Error(`[DI Container] Service '${key}' not registered.`);
    }
    return service as T;
  }

  public has(key: string): boolean {
    return this.services.has(key);
  }
}
