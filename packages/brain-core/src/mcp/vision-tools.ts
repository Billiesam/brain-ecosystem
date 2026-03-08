/**
 * Vision MCP Tools — Image analysis via LLM Vision
 *
 * Tools:
 * - llm_analyze_image: Analyze an image file with a question
 * - llm_analyze_screenshot: Take a screenshot of a URL and analyze it
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '../llm/provider.js';
import type { ImageBlock } from '../llm/structured-output.js';

export interface VisionToolDeps {
  llmProvider: LLMProvider;
  playwrightAdapter?: { extract: (url: string, opts?: { screenshot?: boolean }) => Promise<{ content: string; screenshot?: Buffer }> } | null;
}

/** Create an ImageBlock from a file path. */
export function imageBlockFromFile(filePath: string): ImageBlock {
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mediaType: ImageBlock['mediaType'] =
    ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : 'image/jpeg'; // default to jpeg for .jpg, .jpeg, and others

  return {
    type: 'image',
    data: data.toString('base64'),
    mediaType,
  };
}

/** Create an ImageBlock from a Buffer. */
export function imageBlockFromBuffer(buffer: Buffer, mediaType: ImageBlock['mediaType'] = 'image/png'): ImageBlock {
  return {
    type: 'image',
    data: buffer.toString('base64'),
    mediaType,
  };
}

/** Get the MCP tool definitions for vision. */
export function getVisionToolDefinitions() {
  return [
    {
      name: 'llm_analyze_image',
      description: 'Analyze an image file using LLM vision. Supports JPEG, PNG, WebP.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          imagePath: { type: 'string', description: 'Absolute path to the image file' },
          question: { type: 'string', description: 'Question about the image' },
        },
        required: ['imagePath', 'question'],
      },
    },
    {
      name: 'llm_analyze_screenshot',
      description: 'Take a screenshot of a URL and analyze it using LLM vision. Requires Playwright.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to screenshot' },
          question: { type: 'string', description: 'Question about the page' },
        },
        required: ['url', 'question'],
      },
    },
  ];
}

/** Handle vision tool calls. */
export async function handleVisionTool(
  toolName: string,
  args: Record<string, unknown>,
  deps: VisionToolDeps,
): Promise<string> {
  switch (toolName) {
    case 'llm_analyze_image': {
      const imagePath = args.imagePath as string;
      const question = args.question as string;

      if (!fs.existsSync(imagePath)) {
        return `Error: File not found: ${imagePath}`;
      }

      const imageBlock = imageBlockFromFile(imagePath);
      const result = await deps.llmProvider.chat([
        {
          role: 'user',
          content: [imageBlock, question],
        },
      ]);

      return result.text;
    }

    case 'llm_analyze_screenshot': {
      const url = args.url as string;
      const question = args.question as string;

      if (!deps.playwrightAdapter) {
        return 'Error: Playwright not available for screenshots';
      }

      try {
        const result = await deps.playwrightAdapter.extract(url, { screenshot: true });
        if (!result.screenshot) {
          return `Extracted page text but no screenshot. Text: ${result.content.substring(0, 500)}`;
        }

        const imageBlock = imageBlockFromBuffer(result.screenshot, 'image/png');
        const analysis = await deps.llmProvider.chat([
          {
            role: 'user',
            content: [imageBlock, `URL: ${url}\n\n${question}`],
          },
        ]);

        return analysis.text;
      } catch (err) {
        return `Error taking screenshot: ${(err as Error).message}`;
      }
    }

    default:
      return `Unknown vision tool: ${toolName}`;
  }
}
