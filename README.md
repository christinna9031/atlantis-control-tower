# Atlantis Control Tower

Central dashboard to manage, launch, and monitor all your local development projects from one place.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4-blue) ![Socket.IO](https://img.shields.io/badge/Socket.IO-4-black)

## Features

- **Project Dashboard** — Add projects from the UI, start/stop them, see live status & memory usage
- **Integrated Terminal** — Full PTY terminals per project via xterm.js + node-pty
- **Copilot Integration** — Launch GitHub Copilot CLI sessions with auto-resume
- **Session History** — Browse past Copilot sessions with turn-by-turn context
- **Icon Search** — Search & assign Iconify icons or upload custom ones
- **Auto-start** — Optionally start projects on launch
- **Search** — Fuzzy search across all projects

## Setup

```bash
npm install
node src/server.js
```

Open [http://localhost:9900](http://localhost:9900) and add your projects from the dashboard.

### Windows

You can also double-click `start-control-center.bat` to launch the server and open the browser automatically.
