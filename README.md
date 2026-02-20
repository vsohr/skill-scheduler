# Skill Scheduler

A lightweight scheduler for running [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills (slash commands) on configurable schedules. Define your skills and their schedules in a JSON file, and the scheduler handles timing, state persistence, and auto-reload.

## Features

- **Three schedule types**: daily (HH:MM), interval (every N hours), cron expressions
- **Auto-reload**: edit the config file while running — changes are picked up automatically
- **State persistence**: tracks last run times across restarts (no duplicate runs)
- **Run now**: execute any skill immediately with `--run-now`
- **Enable/disable**: toggle skills without removing them from config
- **Graceful shutdown**: handles SIGINT/SIGTERM cleanly
- **JSON Schema**: editor autocompletion and validation for the config file

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [tsx](https://github.com/privatenumber/tsx) (`npm install -g tsx` or use `npx tsx`)

## Quick Start

### 1. Copy the files into your project

```bash
# Copy the scheduler files to your project
cp skill-scheduler.ts /path/to/your-project/
cp skill-scheduler.schema.json /path/to/your-project/
cp skill-scheduler.sh /path/to/your-project/  # optional shell wrapper
chmod +x /path/to/your-project/skill-scheduler.sh
```

Or keep them in a `scripts/` directory — just pass the config path explicitly.

### 2. Create your config file

Create `skill-scheduler.json` in your project root (or wherever you run the scheduler from):

```json
{
  "$schema": "./skill-scheduler.schema.json",
  "skills": [
    {
      "name": "daily-report",
      "prompt": "/generate-daily-report",
      "schedule": {
        "type": "daily",
        "at": "8:00",
        "timezone": "UTC"
      }
    }
  ]
}
```

See [example-config.json](example-config.json) for a full example with all schedule types.

### 3. Start the scheduler

```bash
# Using npx (no install needed)
npx tsx skill-scheduler.ts

# Or with the shell wrapper
./skill-scheduler.sh

# Or with a custom config path
npx tsx skill-scheduler.ts path/to/my-config.json
```

### 4. Run a skill immediately

```bash
npx tsx skill-scheduler.ts --run-now daily-report
```

## Configuration

### Config File Format

```json
{
  "$schema": "./skill-scheduler.schema.json",
  "skills": [
    {
      "name": "unique-skill-name",
      "prompt": "/slash-command with arguments",
      "schedule": { ... },
      "enabled": true,
      "comment": "Optional description"
    }
  ]
}
```

### Skill Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Unique identifier (used in logs and `--run-now`) |
| `prompt` | Yes | — | The prompt sent to `claude -p` (typically a `/slash-command`) |
| `schedule` | Yes | — | When to run (see Schedule Types below) |
| `enabled` | No | `true` | Set to `false` to disable without removing |
| `comment` | No | — | Human-readable note (ignored by scheduler) |

### Schedule Types

#### Daily

Run once per day at a specific time.

```json
{
  "type": "daily",
  "at": "08:30",
  "timezone": "UTC"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `at` | Yes | Time in `HH:MM` format (24-hour) |
| `timezone` | No | Timezone string (default: `UTC`). Note: current implementation uses system time. |

#### Interval

Run every N hours. First run is immediate if the skill has never run.

```json
{
  "type": "interval",
  "hours": 6
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `hours` | Yes | Hours between executions (minimum: 0.1) |

#### Cron

Standard cron expression for complex schedules.

```json
{
  "type": "cron",
  "expression": "30 0 * * 1"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `expression` | Yes | Cron expression: `minute hour day month weekday` |

**Supported cron syntax:**
- Exact values: `30`, `8`
- Wildcards: `*`
- Ranges: `1-5`
- Lists: `1,3,5`
- Steps: `*/2`, `0/15`

**Examples:**
| Expression | Description |
|------------|-------------|
| `0 8 * * *` | Every day at 8:00 |
| `30 0 * * 1` | Every Monday at 0:30 |
| `0 */4 * * *` | Every 4 hours |
| `0 9 1 * *` | First of every month at 9:00 |

## How It Works

### Execution

Each skill is executed by spawning the Claude Code CLI:

```bash
claude --dangerously-skip-permissions -p "<prompt>"
```

The `--dangerously-skip-permissions` flag is required for non-interactive execution. The scheduler captures stdout/stderr and logs the result.

### State Persistence

Run state is stored in `logs/skill-scheduler-state.json`:

```json
{
  "daily-report": {
    "lastRun": 1708300800000,
    "nextRun": 1708387200000
  }
}
```

This ensures:
- Skills don't re-run if the scheduler restarts within the same interval
- Interval skills resume their cadence from the last run
- Daily skills don't double-fire if restarted on the same day

### Auto-Reload

The scheduler watches the config file using `fs.watch()`. When you edit `skill-scheduler.json`:
1. Change is detected (debounced 500ms)
2. Config is re-parsed
3. State is recalculated for new/changed schedules
4. New schedule takes effect immediately

No restart needed.

### Logging

All activity is logged to both stdout and `logs/skill-scheduler.log`:

```
[2025-01-15T08:00:01.123Z] Executing skill: daily-report
[2025-01-15T08:00:01.124Z]   Prompt: /generate-daily-report
[2025-01-15T08:00:45.678Z]   Skill daily-report completed successfully
[2025-01-15T08:00:45.679Z]   Next run for daily-report: 1/16/2025, 8:00:00 AM
```

## File Structure

```
your-project/
├── skill-scheduler.ts           # The scheduler (copy this)
├── skill-scheduler.schema.json  # JSON Schema for config validation
├── skill-scheduler.sh           # Optional shell wrapper
├── skill-scheduler.json         # Your config (create this)
└── logs/
    ├── skill-scheduler.log            # Execution logs
    └── skill-scheduler-state.json     # Run state (auto-generated)
```

## Running as a Service

### With Docker

Add to your `docker-compose.yml`:

```yaml
services:
  skill-scheduler:
    image: node:20-slim
    working_dir: /app
    volumes:
      - .:/app
      - ./logs:/app/logs
    command: npx tsx skill-scheduler.ts
    restart: unless-stopped
```

### With systemd (Linux)

```ini
[Unit]
Description=Claude Code Skill Scheduler
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/your-project
ExecStart=/usr/bin/npx tsx skill-scheduler.ts
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### With PM2

```bash
pm2 start "npx tsx skill-scheduler.ts" --name skill-scheduler
pm2 save
```

## CLI Reference

```
npx tsx skill-scheduler.ts [config.json]    Start the scheduler
npx tsx skill-scheduler.ts --run-now <name> Run a skill immediately
npx tsx skill-scheduler.ts --help           Show help
```

| Flag | Description |
|------|-------------|
| `[config.json]` | Path to config file (default: `skill-scheduler.json` in CWD) |
| `--run-now <name>` | Execute a skill immediately and exit |
| `--help`, `-h` | Show usage information |

## License

MIT
