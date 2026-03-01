import { getLogger } from '../utils/logger.js';

export interface PlatformConfig {
  name: string;
  maxLength: number;
  hashtagStrategy: 'inline' | 'end' | 'first-comment' | 'none';
  maxHashtags: number;
  supportsThreads: boolean;
  supportsImages: boolean;
  supportsVideo: boolean;
  bestFormats: string[];
  ctaStyle: 'link' | 'question' | 'poll' | 'none';
}

export interface AdaptedPost {
  platform: string;
  content: string;
  format: string;
  hashtags: string | null;
  truncated: boolean;
  threadParts: string[] | null;
  notes: string[];
}

export interface CrossPlatformResult {
  original: { platform: string; content: string };
  adaptations: AdaptedPost[];
}

const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  x: {
    name: 'X',
    maxLength: 280,
    hashtagStrategy: 'inline',
    maxHashtags: 3,
    supportsThreads: true,
    supportsImages: true,
    supportsVideo: true,
    bestFormats: ['text', 'image', 'poll'],
    ctaStyle: 'question',
  },
  linkedin: {
    name: 'LinkedIn',
    maxLength: 3000,
    hashtagStrategy: 'end',
    maxHashtags: 5,
    supportsImages: true,
    supportsVideo: true,
    supportsThreads: false,
    bestFormats: ['article', 'carousel', 'text'],
    ctaStyle: 'question',
  },
  reddit: {
    name: 'Reddit',
    maxLength: 40000,
    hashtagStrategy: 'none',
    maxHashtags: 0,
    supportsThreads: false,
    supportsImages: true,
    supportsVideo: true,
    bestFormats: ['text', 'image'],
    ctaStyle: 'link',
  },
  bluesky: {
    name: 'Bluesky',
    maxLength: 300,
    hashtagStrategy: 'inline',
    maxHashtags: 3,
    supportsThreads: true,
    supportsImages: true,
    supportsVideo: false,
    bestFormats: ['text', 'image'],
    ctaStyle: 'question',
  },
  mastodon: {
    name: 'Mastodon',
    maxLength: 500,
    hashtagStrategy: 'end',
    maxHashtags: 5,
    supportsThreads: false,
    supportsImages: true,
    supportsVideo: true,
    bestFormats: ['text', 'image'],
    ctaStyle: 'link',
  },
  threads: {
    name: 'Threads',
    maxLength: 500,
    hashtagStrategy: 'inline',
    maxHashtags: 5,
    supportsThreads: true,
    supportsImages: true,
    supportsVideo: true,
    bestFormats: ['text', 'image', 'carousel'],
    ctaStyle: 'question',
  },
} as const;

const GENERIC_CONFIG: PlatformConfig = {
  name: 'Generic',
  maxLength: 5000,
  hashtagStrategy: 'end',
  maxHashtags: 10,
  supportsThreads: false,
  supportsImages: true,
  supportsVideo: false,
  bestFormats: ['text'],
  ctaStyle: 'link',
};

export class PlatformAdapterService {
  private logger = getLogger();

  adaptForPlatform(content: string, targetPlatform: string, sourceFormat?: string): AdaptedPost {
    const config = this.getPlatformConfig(targetPlatform);
    const notes: string[] = [];
    let adaptedContent = content;
    let truncated = false;
    let threadParts: string[] | null = null;

    this.logger.debug(`Adapting content for ${config.name} (${targetPlatform})`);

    // --- Adapt hashtags ---
    const hashtagRegex = /#\w+/g;
    const extractedHashtags = adaptedContent.match(hashtagRegex) ?? [];
    let finalHashtags: string[] = extractedHashtags;

    if (finalHashtags.length > config.maxHashtags) {
      finalHashtags = finalHashtags.slice(0, config.maxHashtags);
      notes.push(`Reduced hashtags from ${extractedHashtags.length} to ${config.maxHashtags}`);
    }

    switch (config.hashtagStrategy) {
      case 'inline':
        // Leave hashtags where they are, but remove excess ones
        if (extractedHashtags.length > config.maxHashtags) {
          const toRemove = extractedHashtags.slice(config.maxHashtags);
          for (const tag of toRemove) {
            adaptedContent = adaptedContent.replace(tag, '').replace(/  +/g, ' ');
          }
          adaptedContent = adaptedContent.trim();
        }
        break;
      case 'end': {
        // Remove all hashtags from content and place at the end
        for (const tag of extractedHashtags) {
          adaptedContent = adaptedContent.replace(tag, '').replace(/  +/g, ' ');
        }
        adaptedContent = adaptedContent.trim();
        if (finalHashtags.length > 0) {
          adaptedContent = `${adaptedContent}\n\n${finalHashtags.join(' ')}`;
        }
        break;
      }
      case 'first-comment':
        // Remove hashtags from content; they go in a first comment
        for (const tag of extractedHashtags) {
          adaptedContent = adaptedContent.replace(tag, '').replace(/  +/g, ' ');
        }
        adaptedContent = adaptedContent.trim();
        if (finalHashtags.length > 0) {
          notes.push(`Place hashtags in first comment: ${finalHashtags.join(' ')}`);
        }
        break;
      case 'none':
        // Remove all hashtags
        for (const tag of extractedHashtags) {
          adaptedContent = adaptedContent.replace(tag, '').replace(/  +/g, ' ');
        }
        adaptedContent = adaptedContent.trim();
        if (extractedHashtags.length > 0) {
          notes.push('Hashtags removed (not supported on this platform)');
        }
        finalHashtags = [];
        break;
    }

    // --- Adapt content length ---
    if (adaptedContent.length > config.maxLength) {
      if (config.supportsThreads) {
        threadParts = this.splitIntoThread(adaptedContent, config.maxLength);
        adaptedContent = threadParts[0];
        notes.push(`Content split into ${threadParts.length}-part thread`);
        this.logger.debug(`Split content into ${threadParts.length} thread parts for ${config.name}`);
      } else {
        adaptedContent = adaptedContent.slice(0, config.maxLength - 3) + '...';
        truncated = true;
        notes.push(`Content truncated from ${content.length} to ${config.maxLength} characters`);
        this.logger.debug(`Truncated content for ${config.name}`);
      }
    }

    // --- Determine best format ---
    let format = config.bestFormats[0];
    if (sourceFormat && config.bestFormats.includes(sourceFormat)) {
      format = sourceFormat;
    }

    // --- Platform-specific notes ---
    if (!PLATFORM_CONFIGS[targetPlatform]) {
      notes.push(`Unknown platform "${targetPlatform}"; used generic config`);
    }

    const hashtagsString = finalHashtags.length > 0 ? finalHashtags.join(' ') : null;

    this.logger.info(`Adapted content for ${config.name}: ${adaptedContent.length} chars, format=${format}, truncated=${truncated}`);

    return {
      platform: targetPlatform,
      content: adaptedContent,
      format,
      hashtags: hashtagsString,
      truncated,
      threadParts,
      notes,
    };
  }

  adaptCrossPlatform(content: string, sourcePlatform: string, targetPlatforms?: string[]): CrossPlatformResult {
    const targets = targetPlatforms ?? Object.keys(PLATFORM_CONFIGS).filter(p => p !== sourcePlatform);

    this.logger.info(`Cross-platform adaptation from ${sourcePlatform} to ${targets.length} platforms`);

    const adaptations = targets.map(platform => this.adaptForPlatform(content, platform));

    return {
      original: { platform: sourcePlatform, content },
      adaptations,
    };
  }

  getPlatformConfig(platform: string): PlatformConfig {
    return PLATFORM_CONFIGS[platform] ?? { ...GENERIC_CONFIG, name: platform };
  }

  private splitIntoThread(content: string, maxLength: number): string[] {
    const sentences = content.match(/[^.!?]+[.!?]+[\s]*/g) ?? [content];
    const parts: string[] = [];
    let currentPart = '';

    for (const sentence of sentences) {
      // Reserve space for the part indicator (e.g., " [1/99]")
      const indicatorSpace = 8;
      const effectiveMax = maxLength - indicatorSpace;

      if (currentPart.length + sentence.length > effectiveMax) {
        if (currentPart.length > 0) {
          parts.push(currentPart.trim());
          currentPart = sentence;
        } else {
          // Single sentence exceeds max length; force split
          parts.push(sentence.slice(0, effectiveMax).trim());
          currentPart = sentence.slice(effectiveMax);
        }
      } else {
        currentPart += sentence;
      }
    }

    if (currentPart.trim().length > 0) {
      parts.push(currentPart.trim());
    }

    const totalParts = parts.length;
    return parts.map((part, i) => `${part} [${i + 1}/${totalParts}]`);
  }
}
