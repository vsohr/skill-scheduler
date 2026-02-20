#!/bin/bash
# Skill Scheduler wrapper
# Usage: ./skill-scheduler.sh [args...]
#
# Examples:
#   ./skill-scheduler.sh                              # Start scheduler
#   ./skill-scheduler.sh --run-now my-daily-task       # Run a skill now
#   ./skill-scheduler.sh my-config.json                # Use custom config
#   ./skill-scheduler.sh --help                        # Show help

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

exec npx tsx skill-scheduler.ts "$@"
