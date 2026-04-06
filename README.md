# HMLH GifMaker

Tauri + Rust + React/TypeScript + FFmpeg 기반의 데스크톱 인코딩 앱입니다.

## 구현된 핵심 기능

- 비디오 -> GIF / MP4 / WebM 변환
- 시작/종료 구간, FPS, 너비, 품질 옵션
- 멀티 파일 일괄 등록 + 작업 큐(동시 1~4개)
- 진행률/ETA/speed 표시 + 작업 취소
- 기본 프리셋 + 커스텀 프리셋 저장
- 출력 폴더 지정, 파일명 접미사 자동 적용

## 기술 스택

- App Shell: Tauri v2
- Backend Engine: Rust
- UI: React + TypeScript (Vite)
- Encoder: FFmpeg / ffprobe

## 로컬 실행

1. Node.js 20+ 설치
2. Rust 설치 (`rustup`)
3. Tauri OS prerequisites 설치: [https://tauri.app/start/prerequisites/](https://tauri.app/start/prerequisites/)
4. 의존성 설치

```bash
npm install
```

5. 개발 실행

```bash
npm run tauri dev
```

## FFmpeg 연결 방법

아래 중 하나를 사용하면 됩니다.

- 시스템 PATH에 `ffmpeg` / `ffprobe` 등록
- 환경 변수 지정:
  - `FFMPEG_PATH`
  - `FFPROBE_PATH`
- 번들 리소스 폴더에 배치 (배포용):
  - `src-tauri/resources/ffmpeg/windows/ffmpeg.exe`
  - `src-tauri/resources/ffmpeg/windows/ffprobe.exe`
  - `src-tauri/resources/ffmpeg/macos/ffmpeg`
  - `src-tauri/resources/ffmpeg/macos/ffprobe`
  - `src-tauri/resources/ffmpeg/linux/ffmpeg`
  - `src-tauri/resources/ffmpeg/linux/ffprobe`

## 라이선스 주의

FFmpeg 번들을 배포할 때는 사용한 바이너리 빌드 옵션(LGPL/GPL)에 맞는 고지/의무를 반드시 포함해야 합니다.
기본 고지 파일은 `src-tauri/resources/licenses/FFMPEG_LICENSE_NOTICE.txt`에 있습니다.
