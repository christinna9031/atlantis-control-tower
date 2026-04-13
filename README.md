# Atlantis Control Tower

Central dashboard to manage, launch, and monitor all your local development projects from one place.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4-blue) ![Socket.IO](https://img.shields.io/badge/Socket.IO-4-black)

## Features

- **Project Dashboard** — Add projects, start/stop them, see live status & memory usage
- **Integrated Terminal** — Full PTY terminals per project via xterm.js + node-pty
- **Copilot Integration** — Launch GitHub Copilot CLI sessions with auto-resume
- **Session History** — Browse past Copilot sessions with turn-by-turn context
- **Icon Search** — Search & assign Iconify icons or upload custom ones
- **Auto-start** — Optionally start projects on launch
- **Search** — Fuzzy search across all projects

## Setup

```bash
npm install
```

Copy the example config and add your projects:

```bash
cp projects.example.json projects.json
```

Edit `projects.json` to add your local projects (see the example for the schema).

## Run

```bash
npm start
```

Open [http://localhost:9900](http://localhost:9900)

## Project Config

Each project in `projects.json` supports:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `name` | Display name |
| `icon` | Iconify icon name or emoji |
| `path` | Absolute path to the project |
| `startCommand` | Shell command to start the project |
| `port` | Port the project runs on |
| `healthUrl` | URL to check if the project is running |
| `url` | URL to open in browser |
| `autoStart` | Start automatically on launch |
| `description` | Short description |
| `searchTerms` | Keywords for search |
| `githubUrl` | Link to GitHub repo |
| `productionUrl` | Link to production deployment |
| `env` | Environment variables (key-value object) |
