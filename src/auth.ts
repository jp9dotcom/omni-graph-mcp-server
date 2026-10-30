import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import dotenv from 'dotenv';
import { OAuth2Client } from 'google-auth-library';

// Load environment variables from .env
dotenv.config();

export const TOKEN_PATH = path.resolve(process.cwd(), 'token.json');

// Scopes required for Google Drive, Google Docs, and Gmail
export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

/**
 * Extracts authorization code from raw string or redirected URL
 */
export function extractAuthCode(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get('code');
      if (code) return code;
    } catch {
      // ignore URL parse errors
    }
  }

  const match = trimmed.match(/code=([^&]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }

  return trimmed;
}

/**
 * Creates and initializes an OAuth2Client configured for a Desktop App.
 * If token.json exists, loads existing credentials.
 * If no token exists, prompts the user via console to authorize and saves token.json.
 *
 * @param interactive Whether to prompt the user interactively if token.json is missing.
 */
export async function getOAuth2Client(interactive: boolean = true): Promise<OAuth2Client> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env file. Please check your configuration.'
    );
  }

  // Desktop App OAuth redirect URI registered in Google Cloud Console
  const redirectUri = 'http://localhost';
  const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

  // Automatically persist updated tokens on refresh
  oauth2Client.on('tokens', (newTokens) => {
    try {
      let currentTokens: Record<string, unknown> = {};
      if (fs.existsSync(TOKEN_PATH)) {
        currentTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      }
      const updated = { ...currentTokens, ...newTokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2), 'utf-8');
      console.error('[INFO] OAuth tokens refreshed and saved to token.json');
    } catch (err: unknown) {
      console.error('[WARN] Failed to save refreshed tokens:', err);
    }
  });

  // Check if token.json exists
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const tokenContent = fs.readFileSync(TOKEN_PATH, 'utf-8');
      const tokens = JSON.parse(tokenContent);
      oauth2Client.setCredentials(tokens);
      return oauth2Client;
    } catch (err: unknown) {
      console.error('[WARN] Failed to read existing token.json, proceeding with re-authorization:', err);
    }
  }

  // If non-interactive and no token, advise running the interactive auth flow
  if (!interactive) {
    console.error('\n[FATAL] token.json not found!');
    console.error('Please run "npm run auth" in your terminal first to authorize Google Workspace access.\n');
    throw new Error('No token.json found. Run "npm run auth" first.');
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n================ AUTHORIZATION REQUIRED ================');
  console.log('1. Visit the following authorization URL in your browser:');
  console.log(`\n${authUrl}\n`);
  console.log('2. Sign in with your Google Account and grant the requested permissions.');
  console.log('   (If you see "Google hasn\'t verified this app", click "Advanced" -> "Go to OmniGraph (unsafe)")');
  console.log('3. Google will redirect to: http://localhost/?code=...');
  console.log('   (Even if the page says "This site can\'t be reached", that is normal!)');
  console.log('4. Copy the URL from your browser address bar and paste it below.');
  console.log('========================================================\n');

  // Attempt to open the URL automatically in default browser
  try {
    if (process.platform === 'win32') {
      exec(`start "" "${authUrl}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${authUrl}"`);
    } else {
      exec(`xdg-open "${authUrl}"`);
    }
  } catch {
    // If browser launch fails, user still has the printed URL
  }

  const rl = readline.createInterface({ input, output });
  try {
    let code = '';
    while (!code) {
      const response = await rl.question('Enter the authorization code (or redirected URL): ');
      const extracted = extractAuthCode(response);

      if (extracted) {
        code = extracted;
      } else {
        console.log('No code detected. Please paste the redirected URL or code (or press Ctrl+C to cancel).\n');
      }
    }

    console.log('\nExchanging authorization code for tokens...');
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
    console.log('[SUCCESS] Token successfully obtained and saved to token.json!\n');

    return oauth2Client;
  } finally {
    rl.close();
  }
}

// Standalone execution support: running `npm run auth` directly
const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  getOAuth2Client(true)
    .then(() => {
      console.log('Authentication flow completed successfully.');
      process.exit(0);
    })
    .catch((err: Error) => {
      console.error('Authentication error:', err.message);
      process.exit(1);
    });
}
