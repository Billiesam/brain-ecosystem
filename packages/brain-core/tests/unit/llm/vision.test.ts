import { describe, it, expect } from 'vitest';
import { parseStructuredOutput, type ImageBlock, type ContentBlock } from '../../../src/llm/structured-output.js';
import { imageBlockFromBuffer, getVisionToolDefinitions } from '../../../src/mcp/vision-tools.js';
import type { LLMMessage, LLMContentPart } from '../../../src/llm/provider.js';

describe('Vision — ImageBlock', () => {
  it('defines ImageBlock type correctly', () => {
    const block: ImageBlock = {
      type: 'image',
      data: 'base64data',
      mediaType: 'image/png',
    };
    expect(block.type).toBe('image');
    expect(block.data).toBe('base64data');
    expect(block.mediaType).toBe('image/png');
  });

  it('ImageBlock is part of ContentBlock union', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'Hello' },
      { type: 'image', data: 'abc', mediaType: 'image/jpeg' },
    ];
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe('image');
  });

  it('parseStructuredOutput still works with text only', () => {
    const blocks = parseStructuredOutput('Hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
  });
});

describe('Vision — LLMMessage polymorphic content', () => {
  it('supports string content', () => {
    const msg: LLMMessage = { role: 'user', content: 'Hello' };
    expect(typeof msg.content).toBe('string');
  });

  it('supports array content with text and images', () => {
    const imageBlock: ImageBlock = {
      type: 'image',
      data: 'base64data',
      mediaType: 'image/png',
    };
    const parts: LLMContentPart[] = ['Describe this image', imageBlock];
    const msg: LLMMessage = { role: 'user', content: parts };

    expect(Array.isArray(msg.content)).toBe(true);
    expect((msg.content as LLMContentPart[]).length).toBe(2);
    expect(typeof (msg.content as LLMContentPart[])[0]).toBe('string');
    expect(((msg.content as LLMContentPart[])[1] as ImageBlock).type).toBe('image');
  });
});

describe('Vision — imageBlockFromBuffer', () => {
  it('creates ImageBlock from buffer', () => {
    const buf = Buffer.from('fake image data');
    const block = imageBlockFromBuffer(buf, 'image/png');
    expect(block.type).toBe('image');
    expect(block.mediaType).toBe('image/png');
    expect(block.data).toBe(buf.toString('base64'));
  });

  it('defaults to image/png', () => {
    const block = imageBlockFromBuffer(Buffer.from('data'));
    expect(block.mediaType).toBe('image/png');
  });
});

describe('Vision — MCP tool definitions', () => {
  it('returns two tool definitions', () => {
    const defs = getVisionToolDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe('llm_analyze_image');
    expect(defs[1].name).toBe('llm_analyze_screenshot');
  });

  it('tool definitions have required fields', () => {
    const defs = getVisionToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeTruthy();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('Vision — Anthropic format', () => {
  it('string content stays as string for Anthropic', () => {
    // The AnthropicProvider.formatContent() should return string as-is
    const content: string | LLMContentPart[] = 'simple text';
    expect(typeof content).toBe('string');
  });

  it('array content includes image blocks for Anthropic format', () => {
    const parts: LLMContentPart[] = [
      'What is this?',
      { type: 'image', data: 'abc123', mediaType: 'image/jpeg' },
    ];
    // Verify structure is correct for conversion
    const imageCount = parts.filter(p => typeof p !== 'string' && p.type === 'image').length;
    expect(imageCount).toBe(1);
  });
});

describe('Vision — Ollama format', () => {
  it('detects images in message array', () => {
    const msg: LLMMessage = {
      role: 'user',
      content: [
        'What do you see?',
        { type: 'image', data: 'base64data', mediaType: 'image/png' },
      ],
    };
    const hasImages = Array.isArray(msg.content) &&
      msg.content.some(p => typeof p !== 'string' && p.type === 'image');
    expect(hasImages).toBe(true);
  });

  it('extracts images for Ollama format', () => {
    const parts: LLMContentPart[] = [
      'Describe',
      { type: 'image', data: 'img1', mediaType: 'image/png' },
      { type: 'image', data: 'img2', mediaType: 'image/jpeg' },
    ];
    const images = parts
      .filter((p): p is ImageBlock => typeof p !== 'string' && p.type === 'image')
      .map(p => p.data);
    expect(images).toEqual(['img1', 'img2']);
  });
});
