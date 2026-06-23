/**
 * An in-memory logs-and-jobs domain. The framework knows NOTHING about this — capabilities import it
 * directly, exactly as a real app's capabilities import their own models/db. Deliberately unrelated to
 * Moral Fabric (no tenants, roles, circles, installs) so the extraction proof is honest: if the core
 * needs an MF concept, building this domain will expose it.
 */
export type JobStatus = "running" | "done" | "cancelled";
export interface Job {
  id: string;
  name: string;
  status: JobStatus;
}

const seedLogs: Record<string, string[]> = {
  build: ["build started", "compiling", "build ok"],
  deploy: ["deploy queued", "uploading", "live"],
};

let logs = new Map<string, string[]>();
let jobs = new Map<string, Job>();
let seq = 0;

function seed(): void {
  logs = new Map(Object.entries(seedLogs).map(([k, v]) => [k, [...v]]));
  jobs = new Map();
  seq = 0;
}
seed();

export const store = {
  tail(source: string, limit: number): string[] {
    return (logs.get(source) ?? []).slice(-limit);
  },
  /** Every line currently held for a source, oldest-first — what a streaming `follow` walks over. */
  lines(source: string): string[] {
    return [...(logs.get(source) ?? [])];
  },
  listJobs(): Job[] {
    return [...jobs.values()];
  },
  startJob(name: string): Job {
    const id = `job_${++seq}`;
    const job: Job = { id, name, status: "running" };
    jobs.set(id, job);
    logs.set(id, [`job "${name}" started`]);
    return job;
  },
  cancelJob(id: string): Job | undefined {
    const job = jobs.get(id);
    if (job && job.status === "running") {
      job.status = "cancelled";
      logs.get(id)?.push(`job "${job.name}" cancelled`);
    }
    return job;
  },
  /** Test helper — reset to seed state. */
  reset(): void {
    seed();
  },
};
