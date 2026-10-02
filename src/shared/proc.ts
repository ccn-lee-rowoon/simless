import { dlopen, FFIType, ptr } from "bun:ffi";

/** 프로세스 한 개의 정보 — 세션 찾기·종료 감지에 쓴다 */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** 시작 시각(초) — PID 재사용을 구분한다 */
  startedAt: number;
  /** 커널이 아는 이름 (최대 32자) */
  name: string;
  /** 실행 파일 경로. 못 읽으면 빈 문자열 */
  path: string;
}

export type ProcReader = (pid: number) => ProcInfo | null;

// `ps` 는 한 번에 20~80ms 가 걸려 훅에 쓰기엔 느리다. libproc 을 직접 부르면 수 ms 다.
// struct proc_bsdinfo (sys/proc_info.h) 의 필요한 칸만 읽는다.
const PROC_PIDTBSDINFO = 3;
const BSDINFO_SIZE = 136;
const OFFSET_PID = 12;
const OFFSET_PPID = 16;
const OFFSET_NAME = 64;
const NAME_SIZE = 32;
const OFFSET_START_SEC = 120;
const PATH_MAX = 4096;

let libproc: ReturnType<typeof open> | null = null;

function open() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_pidpath: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** 다른 사용자(root 등)의 프로세스는 읽을 수 없어 null 이다. */
export const readProc: ProcReader = (pid) => {
  libproc ??= open();
  const info = new Uint8Array(BSDINFO_SIZE);
  if (
    libproc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(info), BSDINFO_SIZE) !==
    BSDINFO_SIZE
  ) {
    return null;
  }
  const view = new DataView(info.buffer);
  const pathBuf = new Uint8Array(PATH_MAX);
  const pathLen = libproc.symbols.proc_pidpath(pid, ptr(pathBuf), PATH_MAX);
  return {
    pid: view.getUint32(OFFSET_PID, true),
    ppid: view.getUint32(OFFSET_PPID, true),
    startedAt: Number(view.getBigUint64(OFFSET_START_SEC, true)),
    name: cString(info.subarray(OFFSET_NAME, OFFSET_NAME + NAME_SIZE)),
    path: pathLen > 0 ? cString(pathBuf) : "",
  };
};

/** 같은 PID 가 같은 시작 시각으로 살아 있는지 */
export function isAlive(pid: number, startedAt: number | undefined, read: ProcReader = readProc) {
  const info = read(pid);
  return info !== null && (startedAt === undefined || info.startedAt === startedAt);
}
