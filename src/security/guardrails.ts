import dotenv from 'dotenv';
import { UserRole } from './vault.js';

dotenv.config();

// Common high-risk secret patterns to prevent data exfiltration
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z-_]{35}/g, // Google API Key
  /AKIA[0-9A-Z]{16}/g, // AWS Access Key ID
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // Private Key
  /ghp_[0-9a-zA-Z]{36}/g, // GitHub Personal Access Token
  /xox[baprs]-[0-9a-zA-Z]{10,48}/g, // Slack token
  /GOCSPX-[0-9a-zA-Z_-]{28}/g, // Google OAuth Client Secret
  /eyJ[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}/g, // JWT Token
];

/**
 * Scans content for accidental credentials or secret leaks before sending or persisting.
 */
export function scanForSecrets(content: string): { hasLeak: boolean; reason?: string } {
  if (!content) return { hasLeak: false };

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return {
        hasLeak: true,
        reason: 'Content contains potential sensitive API key, private key, or credential pattern.',
      };
    }
  }

  return { hasLeak: false };
}

/**
 * Validates whether an email recipient is permitted by the enterprise email domain policy.
 */
export function validateEmailRecipient(toEmail: string): { allowed: boolean; reason?: string } {
  const allowedDomainsConfig = process.env.ALLOWED_EMAIL_DOMAINS || '*';

  // Wildcard allows all
  if (allowedDomainsConfig.trim() === '*') {
    return { allowed: true };
  }

  const allowedDomains = allowedDomainsConfig
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  const parts = toEmail.trim().toLowerCase().split('@');
  if (parts.length !== 2) {
    return { allowed: false, reason: `Invalid email address format: "${toEmail}".` };
  }

  const recipientDomain = parts[1];
  const isMatch = allowedDomains.some((d) => recipientDomain === d || recipientDomain.endsWith('.' + d));

  if (!isMatch) {
    return {
      allowed: false,
      reason: `Security Policy: Sending to domain "${recipientDomain}" is blocked. Allowed domains: [${allowedDomains.join(', ')}]`,
    };
  }

  return { allowed: true };
}

/**
 * Enforces Role-Based Access Control (RBAC) on tool execution.
 */
export function checkToolPermission(role: UserRole, toolName: string): { permitted: boolean; reason?: string } {
  if (role === 'admin') {
    return { permitted: true };
  }

  if (role === 'readonly') {
    const readOnlyAllowed = ['search_drive', 'read_doc', 'read_recent_emails'];
    if (!readOnlyAllowed.includes(toolName)) {
      return {
        permitted: false,
        reason: `Access Denied: Role "readonly" is not permitted to execute mutation tool "${toolName}".`,
      };
    }
    return { permitted: true };
  }

  // 'developer' role can execute standard tools
  return { permitted: true };
}
