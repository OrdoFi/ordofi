/** Lightweight in-process metrics with a Prometheus text exposition endpoint. */
export class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  readonly startedAt = Date.now();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    const arr = this.histograms.get(name) ?? [];
    arr.push(ms);
    if (arr.length > 2000) arr.shift();
    this.histograms.set(name, arr);
  }

  private key(name: string, labels: Record<string, string>): string {
    const l = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    return l ? `${name}{${l}}` : name;
  }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  prometheus(): string {
    const lines: string[] = [];
    lines.push(`ordo_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);
    for (const [k, v] of this.counters) lines.push(`ordo_${k} ${v}`);
    for (const [name, arr] of this.histograms) {
      lines.push(`ordo_${name}_p50 ${this.percentile(arr, 50).toFixed(2)}`);
      lines.push(`ordo_${name}_p95 ${this.percentile(arr, 95).toFixed(2)}`);
      lines.push(`ordo_${name}_p99 ${this.percentile(arr, 99).toFixed(2)}`);
    }
    return lines.join("\n") + "\n";
  }

  json(): Record<string, unknown> {
    return {
      uptimeSeconds: (Date.now() - this.startedAt) / 1000,
      counters: Object.fromEntries(this.counters),
      latency: Object.fromEntries(
        [...this.histograms].map(([k, arr]) => [
          k,
          { p50: this.percentile(arr, 50), p95: this.percentile(arr, 95), p99: this.percentile(arr, 99) },
        ]),
      ),
    };
  }
}
