import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import dotenv from 'dotenv';
import { GoogleGenAI, mcpToTool } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Load environment variables
dotenv.config();

/**
 * Ensures GEMINI_API_KEY is available, prompting the user interactively if missing.
 */
async function ensureGeminiApiKey(): Promise<string> {
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.trim();
  }

  console.log('\n================ GEMINI API KEY REQUIRED ================');
  console.log('To power your autonomous agent, please provide a Gemini API key.');
  console.log('You can get one for free at: https://aistudio.google.com/apikey');
  console.log('=========================================================\n');

  const rl = readline.createInterface({ input, output });
  try {
    const key = await rl.question('Enter your GEMINI_API_KEY: ');
    const trimmed = key.trim();
    if (!trimmed) {
      console.error('No API key provided. Exiting.');
      process.exit(1);
    }

    // Persist to .env for future runs
    const envPath = path.resolve(process.cwd(), '.env');
    fs.appendFileSync(envPath, `\nGEMINI_API_KEY=${trimmed}\n`);
    process.env.GEMINI_API_KEY = trimmed;
    console.log('Saved GEMINI_API_KEY to .env\n');

    return trimmed;
  } finally {
    rl.close();
  }
}

/**
 * Helper to execute a chat message with exponential retry on transient (503 / 429) errors,
 * with automatic fallback to a secondary lightweight model if the primary model remains overloaded.
 */
async function sendMessageWithRetryAndFallback(
  primaryChat: any,
  fallbackChatFactory: () => any,
  message: string,
  maxRetries = 3
): Promise<{ text: string }> {
  let attempt = 0;

  // 1. Try primary chat with retry
  while (attempt < maxRetries) {
    try {
      return await primaryChat.sendMessage({ message });
    } catch (err: any) {
      attempt++;
      const isTransient =
        err?.status === 503 ||
        err?.status === 429 ||
        err?.message?.includes('503') ||
        err?.message?.includes('high demand') ||
        err?.message?.includes('Resource has been exhausted');

      if (isTransient && attempt < maxRetries) {
        const delayMs = attempt * 2000;
        console.log(
          `\n⏳ [\x1b[33mHIGH DEMAND\x1b[0m] Google servers are busy (503). Retrying in ${delayMs / 1000}s... (Attempt ${attempt}/${maxRetries})`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      } else if (isTransient) {
        console.log(
          `\n🔄 [\x1b[36mAUTO-FAILOVER\x1b[0m] Primary model is congested. Switching seamlessly to gemini-3.5-flash-lite...`
        );
        break;
      } else {
        throw err;
      }
    }
  }

  // 2. Fallback to secondary model
  const fallbackChat = fallbackChatFactory();
  return await fallbackChat.sendMessage({ message });
}

async function main() {
  const apiKey = await ensureGeminiApiKey();

  console.log('\n🚀 Starting Google Workspace Autonomous AI Agent...');
  console.log('Connecting to local MCP Server via stdio...');

  // Spawn and connect to the local MCP server process
  const serverPath = path.resolve(process.cwd(), 'dist/index.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
  });

  const mcpClient = new Client(
    {
      name: 'omnigraph-autonomous-agent',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  await mcpClient.connect(transport);

  // List available tools from the MCP server
  const { tools } = await mcpClient.listTools();
  console.log(`Connected to MCP Server. Available tools (${tools.length}):`);
  for (const t of tools) {
    console.log(`  • \x1b[36m${t.name}\x1b[0m: ${t.description}`);
  }

  // Intercept callTool to log autonomous actions to the console in real-time
  const originalCallTool = mcpClient.callTool.bind(mcpClient);
  mcpClient.callTool = async (params, resultSchema, options) => {
    console.log(`\n⚙️  [\x1b[33mAUTONOMOUS ACTION\x1b[0m] Invoking MCP tool: \x1b[36m${params.name}\x1b[0m`);
    console.log(`   Arguments:`, JSON.stringify(params.arguments, null, 2));

    const result = await originalCallTool(params, resultSchema, options);

    if (result.isError) {
      console.log(`❌ [\x1b[31mTOOL ERROR\x1b[0m] Tool returned error:`, result.content);
    } else {
      console.log(`✅ [\x1b[32mTOOL SUCCESS\x1b[0m] Tool execution finished.`);
    }

    return result;
  };

  // Convert MCP client to Gemini tool definition
  const geminiMcpTool = mcpToTool(mcpClient);

  // Initialize Gemini client
  const ai = new GoogleGenAI({ apiKey });
  const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const fallbackModel = 'gemini-3.5-flash-lite';

  const systemInstruction = `
You are OmniGraph, an intelligent and autonomous Google Workspace AI assistant.
You have direct access to Google Drive, Google Docs, and Gmail through local MCP tools.

Guidelines:
1. When asked to perform tasks, intelligently decide which tools to call in sequence.
2. For reading emails or searching Drive, inspect the results before deciding the next step.
3. When creating documents or drafting emails, format the content professionally.
4. If a task requires multiple steps (e.g., search Drive for a file, read its text, summarize it into a new Doc, and email the link), execute the steps autonomously until the entire objective is achieved.
5. Provide a clear, helpful final summary when done.
`.trim();

  // Create primary chat session
  let primaryChat = ai.chats.create({
    model: primaryModel,
    config: {
      systemInstruction,
      tools: [geminiMcpTool],
    },
  });

  // Factory for fallback chat session if needed
  const createFallbackChat = () =>
    ai.chats.create({
      model: fallbackModel,
      config: {
        systemInstruction,
        tools: [geminiMcpTool],
      },
    });

  console.log('\n========================================================');
  console.log('🤖 OmniGraph Autonomous Agent is ready!');
  console.log(`   Primary Model:  ${primaryModel}`);
  console.log(`   Failover Model: ${fallbackModel}`);
  console.log('   Type your task below (or type "exit" to quit).');
  console.log('========================================================\n');

  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const userInput = await rl.question('\x1b[35mYou\x1b[0m > ');
      const trimmed = userInput.trim();

      if (!trimmed) continue;
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\nGoodbye! Shutting down agent...');
        break;
      }

      console.log('\n🤖 \x1b[34mOmniGraph is thinking and executing...\x1b[0m');

      try {
        const response = await sendMessageWithRetryAndFallback(
          primaryChat,
          createFallbackChat,
          trimmed
        );

        console.log('\n\x1b[32mOmniGraph\x1b[0m >');
        console.log(response.text || '(No text response)');
        console.log('\n' + '-'.repeat(60) + '\n');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ Error during task execution: ${msg}\n`);
      }
    }
  } finally {
    rl.close();
    await mcpClient.close();
  }
}

main().catch((err) => {
  console.error('[FATAL] Agent failed to start:', err);
  process.exit(1);
});
