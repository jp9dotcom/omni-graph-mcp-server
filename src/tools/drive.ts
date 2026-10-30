import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface DriveFileSummary {
  id: string | null | undefined;
  name: string | null | undefined;
  mimeType: string | null | undefined;
  webViewLink: string | null | undefined;
  modifiedTime: string | null | undefined;
  size: string | null | undefined;
}

/**
 * Searches Google Drive for files matching the given query string.
 * Supports keyword search or full Drive v3 query syntax.
 */
export async function searchDrive(
  auth: OAuth2Client,
  query: string
): Promise<DriveFileSummary[]> {
  const drive = google.drive({ version: 'v3', auth });

  let driveQuery = 'trashed = false';
  const trimmed = (query || '').trim();

  if (trimmed) {
    if (
      trimmed.includes('contains') ||
      trimmed.includes('=') ||
      trimmed.includes('mimeType')
    ) {
      driveQuery = trimmed;
    } else {
      const escaped = trimmed.replace(/'/g, "\\'");
      driveQuery = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
    }
  }

  let res;
  try {
    res = await drive.files.list({
      q: driveQuery,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
      pageSize: 20,
    });
  } catch {
    // Fallback: search strictly on name if complex query is rejected
    const escaped = trimmed.replace(/'/g, "\\'");
    res = await drive.files.list({
      q: `name contains '${escaped}' and trashed = false`,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
      pageSize: 20,
    });
  }

  const files = res.data.files || [];
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink,
    modifiedTime: file.modifiedTime,
    size: file.size,
  }));
}
