// `import x from "./a.md" with { type: "file" }` — 파일 경로(단일 실행 파일 안에서는 /$bunfs/…)를 준다
declare module "*.md" {
  const path: string;
  export default path;
}

// 웹 UI 에서 import 한 이미지 — 번들러가 주는 주소
declare module "*.svg" {
  const url: string;
  export default url;
}
