import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface EmailSummary {
  id: string;
  threadId: string | null | undefined;
  subject: string;
  sender: string;
  date: string;
  snippet: string | null | undefined;
  body: string;
}

export interface SendEmailResult {
  messageId: string | null | undefined;
  threadId: string | null | undefined;
  to: string;
  subject: string;
  status: string;
}

/**
 * Extracts plain text content from a Gmail message payload.
 */
function extractBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return '';

  const decodeBase64Url = (data: string): string => {
    return Buffer.from(data, 'base64url').toString('utf-8');
  };

  // Direct text/plain payload
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Search parts for text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }

    // Recursively check nested parts
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  // Fallback to payload body data
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return '';
}

/**
 * Retrieves the latest Gmail messages for the authenticated user.
 */
export async function readRecentEmails(
  auth: OAuth2Client,
  maxResults: number = 10
): Promise<EmailSummary[]> {
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: Math.max(1, maxResults),
  });

  const list = listRes.data.messages || [];
  if (list.length === 0) {
    return [];
  }

  const emails = await Promise.all(
    list.map(async (item) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: item.id!,
        format: 'full',
      });

      const headers = msg.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

      const subject = getHeader('subject') || '(No Subject)';
      const sender = getHeader('from') || 'Unknown';
      const date = getHeader('date') || '';
      const body = extractBody(msg.data.payload) || msg.data.snippet || '';

      return {
        id: item.id!,
        threadId: msg.data.threadId,
        subject,
        sender,
        date,
        snippet: msg.data.snippet,
        body: body.trim(),
      };
    })
  );

  return emails;
}

/**
 * Constructs a base64url-encoded MIME email and sends it via the Gmail API.
 */
export async function sendEmail(
  auth: OAuth2Client,
  to: string,
  subject: string,
  body: string
): Promise<SendEmailResult> {
  const gmail = google.gmail({ version: 'v1', auth });

  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${utf8Subject}`,
    '',
    body,
  ];

  const rawMessage = messageParts.join('\r\n');
  const encodedMessage = Buffer.from(rawMessage).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
    },
  });

  return {
    messageId: res.data.id,
    threadId: res.data.threadId,
    to,
    subject,
    status: 'Email sent successfully',
  };
}
