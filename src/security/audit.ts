import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AuditEntry {
  id?: string;
  timestamp?: string;
  userId: string;
  role: string;
  toolName: string;
  parameters: Record<string, unknown>;
  status: 'SUCCESS' | 'BLOCKED_BY_GUARDRAIL' | 'ERROR';
  durationMs: number;
  errorMessage?: string;
  ipAddress?: string;
}

const AUDIT_LOG_FILE = path.resolve(process.cwd(), 'data', 'audit.log');

export class AuditLogger {
  constructor() {
    const dataDir = path.dirname(AUDIT_LOG_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  /**
   * Appends an immutable structured audit log entry.
   */
  public log(entry: AuditEntry): void {
    const record: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const line = JSON.stringify(record) + '\n';
    fs.appendFile(AUDIT_LOG_FILE, line, (err) => {
      if (err) {
        console.error('[AUDIT] Failed to append to audit.log:', err);
      }
    });
  }

  /**
   * Reads recent audit entries for admin monitoring.
   */
  public getRecent(limit = 50): AuditEntry[] {
    if (!fs.existsSync(AUDIT_LOG_FILE)) {
      return [];
    }

    try {
      const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entries: AuditEntry[] = [];

      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try {
          entries.push(JSON.parse(lines[i]));
        } catch {
          // ignore corrupted line
        }
      }

      return entries;
    } catch (err) {
      console.error('[AUDIT] Failed to read audit log:', err);
      return [];
    }
  }
}

export const auditLogger = new AuditLogger();
