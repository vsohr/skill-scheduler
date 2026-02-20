#!/usr/bin/env npx tsx
/**
 * Skill Scheduler for Claude Code
 *
 * Runs Claude Code skills (slash commands) on configurable schedules.
 * Supports daily, interval, and cron schedules with auto-reload on config change.
 *
 * Usage:
 *   npx tsx skill-scheduler.ts [config-file]
 *   npx tsx skill-scheduler.ts --run-now <skill-name>
 *   npx tsx skill-scheduler.ts --help
 *
 * Default config: skill-scheduler.json in current directory
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface DailySchedule {
    type: 'daily';
    at: string; // HH:MM
    timezone?: string;
}

interface IntervalSchedule {
    type: 'interval';
    hours: number;
}

interface CronSchedule {
    type: 'cron';
    expression: string;
}

type Schedule = DailySchedule | IntervalSchedule | CronSchedule;

interface SkillConfig {
    name: string;
    prompt: string;
    schedule: Schedule;
    enabled?: boolean;
    comment?: string;
}

interface SchedulerConfig {
    skills: SkillConfig[];
}

interface SkillState {
    lastRun: number | null;
    nextRun: number;
}

// ============================================================================
// Logging
// ============================================================================

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'skill-scheduler.log');

function ensureLogDir(): void {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

// ============================================================================
// Schedule Calculations
// ============================================================================

function parseTimeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
}

function getNextDailyRun(schedule: DailySchedule, lastRun: number | null): number {
    const now = new Date();
    const targetMinutes = parseTimeToMinutes(schedule.at);

    // Create target time for today
    const target = new Date(now);
    target.setHours(Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0);

    // If we've already passed today's time, schedule for tomorrow
    if (now.getTime() > target.getTime()) {
        target.setDate(target.getDate() + 1);
    }

    // If we ran today already (within last 23 hours at the scheduled time), schedule tomorrow
    if (lastRun !== null) {
        const lastRunDate = new Date(lastRun);
        const hoursSinceLastRun = (now.getTime() - lastRun) / (1000 * 60 * 60);
        if (hoursSinceLastRun < 23 && lastRunDate.getDate() === now.getDate()) {
            target.setDate(target.getDate() + 1);
        }
    }

    return target.getTime();
}

function getNextIntervalRun(schedule: IntervalSchedule, lastRun: number | null): number {
    const intervalMs = schedule.hours * 60 * 60 * 1000;
    if (lastRun === null) {
        // Run immediately if never run
        return Date.now();
    }
    return lastRun + intervalMs;
}

function parseCronField(field: string, max: number): number[] {
    if (field === '*') {
        return Array.from({ length: max }, (_, i) => i);
    }
    if (field.includes('/')) {
        const [, step] = field.split('/');
        return Array.from({ length: Math.ceil(max / Number(step)) }, (_, i) => i * Number(step));
    }
    if (field.includes(',')) {
        return field.split(',').map(Number);
    }
    if (field.includes('-')) {
        const [start, end] = field.split('-').map(Number);
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    return [Number(field)];
}

function getNextCronRun(schedule: CronSchedule, _lastRun: number | null): number {
    // Simple cron parser for common patterns: "minute hour day month weekday"
    const [minuteField, hourField] = schedule.expression.split(' ');
    const minutes = parseCronField(minuteField, 60);
    const hours = parseCronField(hourField, 24);

    const now = new Date();
    const target = new Date(now);

    // Find next matching time
    for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
        target.setDate(now.getDate() + dayOffset);
        for (const hour of hours) {
            for (const minute of minutes) {
                target.setHours(hour, minute, 0, 0);
                if (target.getTime() > now.getTime()) {
                    return target.getTime();
                }
            }
        }
    }

    // Fallback: tomorrow at first scheduled time
    target.setDate(now.getDate() + 1);
    target.setHours(hours[0], minutes[0], 0, 0);
    return target.getTime();
}

function getNextRun(schedule: Schedule, lastRun: number | null): number {
    switch (schedule.type) {
        case 'daily':
            return getNextDailyRun(schedule, lastRun);
        case 'interval':
            return getNextIntervalRun(schedule, lastRun);
        case 'cron':
            return getNextCronRun(schedule, lastRun);
    }
}

// ============================================================================
// Skill Execution
// ============================================================================

async function executeSkill(skill: SkillConfig): Promise<boolean> {
    log(`Executing skill: ${skill.name}`);
    log(`  Prompt: ${skill.prompt}`);

    return new Promise((resolve) => {
        const escapedPrompt = skill.prompt.replace(/"/g, '\\"');
        const command = `claude --dangerously-skip-permissions -p "${escapedPrompt}"`;

        const proc = spawn(command, {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
        });

        let output = '';

        proc.stdout?.on('data', (data: Buffer) => {
            output += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            output += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                log(`  Skill ${skill.name} completed successfully`);
                resolve(true);
            } else {
                log(`  ERROR: Skill ${skill.name} failed with code ${code}`);
                log(`  Output: ${output.slice(-500)}`);
                resolve(false);
            }
        });

        proc.on('error', (err) => {
            log(`  ERROR: Failed to spawn claude CLI: ${err.message}`);
            resolve(false);
        });
    });
}

// ============================================================================
// State Management
// ============================================================================

const STATE_FILE = path.join(LOG_DIR, 'skill-scheduler-state.json');

function loadState(): Record<string, SkillState> {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch {
        log('Warning: Could not load state file, starting fresh');
    }
    return {};
}

function saveState(state: Record<string, SkillState>): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// Main Loop
// ============================================================================

function loadConfig(configPath: string): SchedulerConfig {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function initializeState(
    config: SchedulerConfig,
    state: Record<string, SkillState>
): void {
    for (const skill of config.skills) {
        if (!state[skill.name]) {
            state[skill.name] = {
                lastRun: null,
                nextRun: getNextRun(skill.schedule, null),
            };
        } else {
            // Recalculate next run based on config (in case schedule changed)
            state[skill.name].nextRun = getNextRun(skill.schedule, state[skill.name].lastRun);
        }
    }
}

function logSchedulerStatus(config: SchedulerConfig, state: Record<string, SkillState>, configPath: string): void {
    log('==========================================');
    log('Skill Scheduler Status');
    log(`Config: ${configPath}`);
    log(`Skills: ${config.skills.length}`);
    for (const skill of config.skills) {
        const enabled = skill.enabled !== false;
        const nextRun = new Date(state[skill.name].nextRun).toLocaleString();
        log(`  - ${skill.name}: ${enabled ? 'enabled' : 'DISABLED'}, next: ${nextRun}`);
    }
    log('==========================================');
}

async function runScheduler(configPath: string): Promise<void> {
    if (!fs.existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`);
        process.exit(1);
    }

    let config: SchedulerConfig = loadConfig(configPath);
    const state = loadState();

    initializeState(config, state);

    log('==========================================');
    log('Skill Scheduler Started');
    logSchedulerStatus(config, state, configPath);

    // Watch config file for changes (auto-reload)
    let reloadTimeout: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 500;

    fs.watch(configPath, (eventType) => {
        if (eventType === 'change') {
            if (reloadTimeout) clearTimeout(reloadTimeout);
            reloadTimeout = setTimeout(() => {
                try {
                    log('Config file changed, reloading...');
                    config = loadConfig(configPath);
                    initializeState(config, state);
                    saveState(state);
                    logSchedulerStatus(config, state, configPath);
                } catch (err) {
                    log(`ERROR: Failed to reload config: ${err instanceof Error ? err.message : err}`);
                }
            }, DEBOUNCE_MS);
        }
    });

    log('Watching config file for changes (auto-reload enabled)');

    // Graceful shutdown
    let running = true;
    process.on('SIGINT', () => {
        log('Received SIGINT, shutting down...');
        running = false;
    });
    process.on('SIGTERM', () => {
        log('Received SIGTERM, shutting down...');
        running = false;
    });

    // Main loop - check every minute
    const CHECK_INTERVAL = 60 * 1000;

    while (running) {
        const now = Date.now();

        for (const skill of config.skills) {
            if (skill.enabled === false) continue;

            const skillState = state[skill.name];

            if (now >= skillState.nextRun) {
                const success = await executeSkill(skill);

                skillState.lastRun = now;
                skillState.nextRun = getNextRun(skill.schedule, now);
                saveState(state);

                const nextRun = new Date(skillState.nextRun).toLocaleString();
                log(`  Next run for ${skill.name}: ${nextRun}`);

                if (!success) {
                    log(`  Warning: ${skill.name} failed, will retry at next scheduled time`);
                }
            }
        }

        await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
    }

    log('Scheduler stopped');
}

async function runSkillNow(configPath: string, skillName: string): Promise<void> {
    if (!fs.existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`);
        process.exit(1);
    }

    const config: SchedulerConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const skill = config.skills.find((s) => s.name === skillName);

    if (!skill) {
        console.error(`Skill not found: ${skillName}`);
        console.error(`Available skills: ${config.skills.map((s) => s.name).join(', ')}`);
        process.exit(1);
    }

    log(`Running skill immediately: ${skillName}`);
    const success = await executeSkill(skill);

    if (success) {
        const state = loadState();
        if (!state[skill.name]) {
            state[skill.name] = { lastRun: null, nextRun: 0 };
        }
        state[skill.name].lastRun = Date.now();
        state[skill.name].nextRun = getNextRun(skill.schedule, Date.now());
        saveState(state);
    }

    process.exit(success ? 0 : 1);
}

// ============================================================================
// Entry Point
// ============================================================================

ensureLogDir();

const args = process.argv.slice(2);
const defaultConfig = path.join(process.cwd(), 'skill-scheduler.json');

if (args.includes('--run-now')) {
    const runNowIndex = args.indexOf('--run-now');
    const skillName = args[runNowIndex + 1];
    const configPath = args.find((a) => a.endsWith('.json')) || defaultConfig;

    if (!skillName) {
        console.error('Usage: npx tsx skill-scheduler.ts --run-now <skill-name>');
        process.exit(1);
    }

    runSkillNow(configPath, skillName);
} else if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Skill Scheduler — Run Claude Code skills on a schedule

Usage:
  npx tsx skill-scheduler.ts [config.json]    Start the scheduler
  npx tsx skill-scheduler.ts --run-now <name> Run a skill immediately
  npx tsx skill-scheduler.ts --help           Show this help

Features:
  - Schedule types: daily (HH:MM), interval (every N hours), cron
  - Auto-reload: config file is watched, no restart needed after edits
  - State persistence: tracks last run times across restarts
  - Graceful shutdown: SIGINT/SIGTERM handled cleanly

Config Format (skill-scheduler.json):
{
  "skills": [
    {
      "name": "my-daily-task",
      "prompt": "/my-skill do the thing",
      "schedule": { "type": "daily", "at": "08:00" }
    },
    {
      "name": "periodic-check",
      "prompt": "/check-status",
      "schedule": { "type": "interval", "hours": 6 }
    },
    {
      "name": "weekly-report",
      "prompt": "/weekly-report",
      "schedule": { "type": "cron", "expression": "0 9 * * 1" }
    }
  ]
}

Schedule Types:
  daily:    { "type": "daily", "at": "HH:MM", "timezone": "UTC" }
  interval: { "type": "interval", "hours": N }
  cron:     { "type": "cron", "expression": "min hour day month weekday" }

Logs:    ./logs/skill-scheduler.log
State:   ./logs/skill-scheduler-state.json
`);
    process.exit(0);
} else {
    const configPath = args[0] || defaultConfig;
    runScheduler(configPath);
}
