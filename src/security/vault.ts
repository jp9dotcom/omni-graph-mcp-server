import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encrypt, decrypt } from './encryption.js';

export type UserRole = 'admin' | 'developer' | 'readonly';

export interface TeamMember {
  id: string; // Email or unique user identifier
  name: string;
  role: UserRole;
  apiKey: string; // Bearer key used to connect to the MCP server
  encryptedGoogleTokens?: string; // AES-256-GCM encrypted Google OAuth tokens
  createdAt: string;
  updatedAt: string;
}

const VAULT_FILE = path.resolve(process.cwd(), 'data', 'vault.json');

class TokenVault {
  private members: Map<string, TeamMember> = new Map();

  constructor() {
    this.init();
  }

  private init() {
    const dataDir = path.dirname(VAULT_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (fs.existsSync(VAULT_FILE)) {
      try {
        const raw = fs.readFileSync(VAULT_FILE, 'utf-8');
        const list: TeamMember[] = JSON.parse(raw);
        for (const m of list) {
          this.members.set(m.id, m);
        }
      } catch (err) {
        console.error('[VAULT] Failed to parse vault.json:', err);
      }
    } else {
      // Bootstrap with default admin/developer from existing token.json if present
      this.bootstrapFromExistingToken();
    }
  }

  private bootstrapFromExistingToken() {
    const localTokenPath = path.resolve(process.cwd(), 'token.json');
    let encryptedTokens: string | undefined = undefined;

    if (fs.existsSync(localTokenPath)) {
      try {
        const raw = fs.readFileSync(localTokenPath, 'utf-8');
        encryptedTokens = encrypt(raw);
      } catch (err) {
        console.error('[VAULT] Could not import local token.json:', err);
      }
    }

    const defaultAdminKey = 'omni_admin_' + crypto.randomBytes(16).toString('hex');
    const defaultAdmin: TeamMember = {
      id: 'admin@omnigraph.local',
      name: 'OmniGraph Team Admin',
      role: 'admin',
      apiKey: defaultAdminKey,
      encryptedGoogleTokens: encryptedTokens,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.members.set(defaultAdmin.id, defaultAdmin);
    this.save();

    console.log('\n========================================================');
    console.log('🔑 [ENTERPRISE VAULT] Initialized Team Vault with Admin:');
    console.log(`   User:     ${defaultAdmin.id}`);
    console.log(`   API Key:  ${defaultAdminKey}`);
    console.log('========================================================\n');
  }

  private save() {
    const list = Array.from(this.members.values());
    fs.writeFileSync(VAULT_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  }

  public getUserByApiKey(apiKey: string): TeamMember | undefined {
    if (!apiKey) return undefined;
    const cleanKey = apiKey.trim().replace(/^Bearer\s+/i, '');
    for (const m of this.members.values()) {
      if (m.apiKey === cleanKey) {
        return m;
      }
    }
    return undefined;
  }

  public getUserById(id: string): TeamMember | undefined {
    return this.members.get(id);
  }

  public listUsers(): Omit<TeamMember, 'encryptedGoogleTokens'>[] {
    return Array.from(this.members.values()).map(({ encryptedGoogleTokens, ...rest }) => rest);
  }

  public registerUser(name: string, email: string, role: UserRole = 'developer'): TeamMember {
    const existing = this.members.get(email);
    if (existing) {
      existing.name = name;
      existing.role = role;
      existing.updatedAt = new Date().toISOString();
      this.save();
      return existing;
    }

    const newKey = `omni_${role}_` + crypto.randomBytes(20).toString('hex');
    const member: TeamMember = {
      id: email,
      name,
      role,
      apiKey: newKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.members.set(email, member);
    this.save();
    return member;
  }

  public saveGoogleTokens(userId: string, tokens: object): void {
    const member = this.members.get(userId);
    if (!member) {
      throw new Error(`User ${userId} not found in vault.`);
    }

    member.encryptedGoogleTokens = encrypt(JSON.stringify(tokens));
    member.updatedAt = new Date().toISOString();
    this.save();
  }

  public getGoogleTokens(userId: string): object | null {
    const member = this.members.get(userId);
    if (!member || !member.encryptedGoogleTokens) {
      return null;
    }

    try {
      const decrypted = decrypt(member.encryptedGoogleTokens);
      return JSON.parse(decrypted);
    } catch (err) {
      console.error(`[VAULT] Failed to decrypt Google tokens for ${userId}:`, err);
      return null;
    }
  }
}

export const vault = new TokenVault();
