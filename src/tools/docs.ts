import { google, docs_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface ReadDocResult {
  documentId: string;
  title: string | null | undefined;
  content: string;
}

export interface CreateDocResult {
  documentId: string;
  title: string;
  documentUrl: string;
}

/**
 * Recursively extracts plain text from Google Docs structural elements.
 */
function extractText(elements?: docs_v1.Schema$StructuralElement[]): string {
  if (!elements) return '';
  let text = '';

  for (const el of elements) {
    if (el.paragraph?.elements) {
      for (const pe of el.paragraph.elements) {
        if (pe.textRun?.content) {
          text += pe.textRun.content;
        }
      }
    } else if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells || []) {
          text += extractText(cell.content);
        }
      }
    } else if (el.tableOfContents?.content) {
      text += extractText(el.tableOfContents.content);
    }
  }

  return text;
}

/**
 * Reads a Google Doc by its documentId and returns the text content.
 */
export async function readDoc(
  auth: OAuth2Client,
  documentId: string
): Promise<ReadDocResult> {
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.get({
    documentId,
  });

  const content = extractText(res.data.body?.content).trim();

  return {
    documentId,
    title: res.data.title,
    content,
  };
}

/**
 * Creates a new Google Doc with the given title, inserts the content text,
 * and returns the document link.
 */
export async function createDoc(
  auth: OAuth2Client,
  title: string,
  content: string
): Promise<CreateDocResult> {
  const docs = google.docs({ version: 'v1', auth });

  // Create the blank document
  const createRes = await docs.documents.create({
    requestBody: {
      title,
    },
  });

  const documentId = createRes.data.documentId;
  if (!documentId) {
    throw new Error('Failed to retrieve documentId for newly created document.');
  }

  // Insert text content if provided
  if (content && content.length > 0) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: {
                index: 1,
              },
              text: content,
            },
          },
        ],
      },
    });
  }

  const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;

  return {
    documentId,
    title: createRes.data.title || title,
    documentUrl,
  };
}
