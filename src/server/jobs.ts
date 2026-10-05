import { type Fix, fixCommandLine, fixEnv } from "../install/fixes.ts";
import type { FixId, JobView } from "../shared/api.ts";
import type { ServerEvent } from "./app.ts";

// 설정 창의 설치 실행 (M14) — 정해 둔 명령(install/fixes.ts)을 뒤에서 돌리고 출력을 한 줄씩 알린다.
// HTTP 요청은 바로 돌려주고(긴 brew 설치가 요청 시간 제한에 걸리지 않게), 창을 닫아도 계속 돈다.

const MAX_LINES = 400;

interface Job extends JobView {
  proc?: ReturnType<typeof Bun.spawn>;
}

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;

  constructor(
    private readonly publish: (event: ServerEvent) => void,
    private readonly env: () => NodeJS.ProcessEnv,
  ) {}

  list(): JobView[] {
    return [...this.jobs.values()].map(view);
  }

  /** 같은 항목이 이미 돌고 있으면 그것을 돌려준다 */
  start(fix: Fix): JobView {
    const running = [...this.jobs.values()].find((j) => j.fix === fix.id && j.status === "running");
    if (running) return view(running);
    // 끝난 같은 항목은 새로 시작하면 지운다 — 창에는 마지막 실행만
    for (const [id, j] of this.jobs) if (j.fix === fix.id) this.jobs.delete(id);
    const job: Job = {
      id: `job-${++this.seq}`,
      fix: fix.id,
      status: "running",
      lines: [],
      command: fixCommandLine(fix),
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.changed(job);
    void this.run(job, fix);
    return view(job);
  }

  cancel(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "running") {
      job.status = "canceled";
      job.proc?.kill();
      job.endedAt = Date.now();
      this.changed(job);
    }
    return view(job);
  }

  private line(job: Job, text: string): void {
    job.lines.push(text);
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
    this.publish({ type: "output", job: job.id, line: text });
  }

  private changed(job: Job): void {
    this.publish({ type: "job", job: view(job) });
  }

  private async run(job: Job, fix: Fix): Promise<void> {
    let code = 0;
    for (const step of fix.steps) {
      if (job.status !== "running") return;
      let result = await this.exec(job, step.command);
      if (result.code !== 0 && step.retry && step.retryWhen?.test(result.output)) {
        if (job.status !== "running") return;
        await this.exec(job, step.retry);
        // 열기(open)는 대신 연 것이 결과다 — 같은 단계를 다시 하지 않는다
        result = fix.kind === "open" ? { code: 0, output: "" } : await this.exec(job, step.command);
      }
      code = result.code;
      if (code !== 0) break;
    }
    if (job.status !== "running") return;
    job.status = code === 0 ? "done" : "failed";
    job.exitCode = code;
    job.endedAt = Date.now();
    this.changed(job);
  }

  /** 명령 하나 — stdout·stderr 를 줄 단위로 알린다. brew 의 \r 진행 표시도 한 줄로 */
  private async exec(job: Job, command: string[]): Promise<{ code: number; output: string }> {
    this.line(job, `$ ${command.join(" ")}`);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: fixEnv(this.env()),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.line(job, message);
      return { code: 127, output: message };
    }
    job.proc = proc;
    let output = "";
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let rest = "";
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        output += text;
        const parts = (rest + text).split(/\r\n|\n|\r/);
        rest = parts.pop() ?? "";
        for (const part of parts) if (part.trim()) this.line(job, part);
      }
      if (rest.trim()) this.line(job, rest);
    };
    await Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>),
      pump(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    const code = await proc.exited;
    job.proc = undefined;
    return { code, output };
  }
}

function view(job: Job): JobView {
  const { proc: _proc, ...rest } = job;
  return { ...rest, lines: [...rest.lines] };
}

/** 고칠 항목 ID 인지 — 웹이 보낸 값을 그대로 믿지 않는다 */
export function isFixId(id: string, fixes: Record<string, Fix>): id is FixId {
  return Object.hasOwn(fixes, id);
}
