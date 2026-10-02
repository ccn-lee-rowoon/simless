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

// 바이너리에 넣는 앱 아이콘
declare module "*.icns" {
  const path: string;
  export default path;
}

// 메뉴바 앱 소스 — 설치 때 그 Mac 에서 컴파일한다
declare module "*.swift" {
  const path: string;
  export default path;
}
