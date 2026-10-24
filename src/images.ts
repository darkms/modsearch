import { allowsPrivateNetwork, loadConfigFile, type ModsearchConfig } from './config.ts';
import { runFetch, type FetchResult } from './providers/httpFetch.ts';

/**
 * Image search is a fourth capability next to web search, page fetch, and X:
 * the web engines answer with documents, and none of them returns image
 * results in a shape a model can use. A self-hosted SearXNG instance does,
 * through its `categories=images` JSON endpoint, and that is what this module
 * talks to.
 *
 * The engine stays external on purpose. SearXNG already aggregates the image
 * backends (bing, duckduckgo, flickr, wikicommons, ...) and keeps their keys
 * and quotas; modsearch only normalizes the answer. There is no keyless
 * default: an image search needs an instance the user actually runs, so the
 * base URL is required rather than guessed.
 */

/** Where the searched instance lives when nothing names one. */
export const SEARXNG_ENV = 'SEARXNG_BASE_URL';

/** The config key that names it, in the same shape as every other engine. */
export const SEARXNG_CONFIG_PATH = 'engines.searxng.baseURL';

export interface ImageResult {
  /** Human-readable caption from the source page, when it had one. */
  title: string;
  /** The image itself, absolute http(s). Hotlink it or download it. */
  imageUrl: string;
  /** A smaller copy, when the instance knows one. */
  thumbnailUrl?: string;
  /** The page the image was found on, not the image. */
  pageUrl?: string;
  /** Host of the page, e.g. `pexels.com`. */
  source?: string;
  /** Which backend produced the hit, e.g. `bing images`. */
  engine?: string;
  width?: number;
  height?: number;
}

export interface ImageSearchEnvelope {
  query: string;
  engine: 'searxng';
  baseURL: string;
  count: number;
  images: ImageResult[];
  warnings: string[];
}

export interface ImageSearchOptions {
  query: string;
  maxResults?: number;
  /** Overrides config and environment for this run. */
  baseURL?: string;
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  config?: ModsearchConfig;
  /** Injection seam for tests; production always uses the hardened fetcher. */
  fetcher?: (options: {
    url: string;
    timeoutMs?: number;
    maxBytes?: number;
    maxChars?: number;
    allowPrivateNetwork?: boolean;
  }) => Promise<Pick<FetchResult, 'status' | 'statusText' | 'text' | 'finalUrl'>>;
}

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_CAP = 50;
const DEFAULT_TIMEOUT_MS = 20_000;
/** A 20-hit image payload is bulky; the page fetcher's page-sized caps are too small. */
const MAX_BYTES = 4_000_000;
const MAX_CHARS = 1_000_000;

/**
 * Resolve the instance base URL from the flag, then config, then environment.
 * A missing value is a configuration mistake with a fix, not a transport error.
 */
export function resolveSearxngBaseURL(
  explicit: string | undefined,
  config: ModsearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = explicit ?? config.engines?.searxng?.baseURL ?? env[SEARXNG_ENV];
  const trimmed = candidate?.trim();
  if (!trimmed) {
    throw new Error(
      `Image search needs a SearXNG instance: set ${SEARXNG_CONFIG_PATH} (or ${SEARXNG_ENV}). ` +
        'A self-hosted instance answers the same URL as the web UI, e.g. https://searx.example.com',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid SearXNG base URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Not an http(s) SearXNG base URL: ${trimmed}`);
  }
  return trimmed.replace(/\/+$/, '');
}

/** `https://host/base` + `search?...` keeps any reverse-proxy prefix intact. */
export function buildImageSearchUrl(baseURL: string, query: string): string {
  const url = new URL('search', `${baseURL}/`);
  url.searchParams.set('q', query);
  url.searchParams.set('categories', 'images');
  url.searchParams.set('format', 'json');
  return url.toString();
}

/** Protocol-relative hits (`//live.staticflickr.com/...`) are common; make them absolute. */
export function normalizeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const raw = value.trim();
  if (raw === '') {
    return undefined;
  }
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
  if (!/^https?:\/\//i.test(absolute)) {
    return undefined;
  }
  try {
    const url = new URL(absolute);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** SearXNG reports `resolution` as `1920×1080`, with either multiplication sign. */
export function parseResolution(value: unknown): { width?: number; height?: number } {
  if (typeof value !== 'string') {
    return {};
  }
  const match = value.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
  if (!match) {
    return {};
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.min(Math.floor(value), MAX_RESULTS_CAP);
}

function toImageResult(entry: unknown): ImageResult | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const imageUrl = normalizeImageUrl(record.img_src) ?? normalizeImageUrl(record.thumbnail_src);
  if (!imageUrl) {
    return undefined;
  }
  const thumbnailUrl = normalizeImageUrl(record.thumbnail_src);
  const pageUrl = normalizeImageUrl(record.url);
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const source = typeof record.source === 'string' ? record.source.trim() : undefined;
  const engine = typeof record.engine === 'string' ? record.engine.trim() : undefined;
  const { width, height } = parseResolution(record.resolution);
  return {
    title,
    imageUrl,
    ...(thumbnailUrl && thumbnailUrl !== imageUrl ? { thumbnailUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(source ? { source } : {}),
    ...(engine ? { engine } : {}),
    ...(width && height ? { width, height } : {}),
  };
}

/**
 * Search images through SearXNG and normalize the answer.
 *
 * The envelope mirrors the search envelope's philosophy: what was found, plus
 * the caveats that make it trustworthy. `warnings` carries the "your instance
 * answered but with nothing usable" case instead of returning a silent empty
 * list, and the raw failure cases throw with the instance name in the message.
 */
export async function searchImages(options: ImageSearchOptions): Promise<ImageSearchEnvelope> {
  const query = options.query?.trim();
  if (!query) {
    throw new Error('Image search needs a non-empty query.');
  }

  const config = options.config ?? loadConfigFile();
  const baseURL = resolveSearxngBaseURL(options.baseURL, config);
  const limit = clampMaxResults(options.maxResults);
  const allowPrivate = options.allowPrivateNetwork ?? allowsPrivateNetwork(config);
  const fetcher = options.fetcher ?? runFetch;

  const requestUrl = buildImageSearchUrl(baseURL, query);
  const response = await fetcher({
    url: requestUrl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    maxChars: MAX_CHARS,
    allowPrivateNetwork: allowPrivate,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `SearXNG at ${baseURL} answered ${response.status} ${response.statusText || ''}`.trim() +
        '. Check that the instance is up and that its JSON API is enabled.',
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch {
    // SearXNG answers the browser UI when `search.formats` leaves json out, so
    // this is a configuration answer, not a broken instance.
    throw new Error(
      `SearXNG at ${baseURL} did not answer JSON. Enable it in the instance settings ` +
        '(search.formats must include json), then retry.',
    );
  }

  const rawResults =
    typeof payload === 'object' && payload !== null && Array.isArray((payload as { results?: unknown }).results)
      ? ((payload as { results: unknown[] }).results as unknown[])
      : [];

  const images: ImageResult[] = [];
  const seen = new Set<string>();
  for (const entry of rawResults) {
    const image = toImageResult(entry);
    if (!image || seen.has(image.imageUrl)) {
      continue;
    }
    seen.add(image.imageUrl);
    images.push(image);
    if (images.length >= limit) {
      break;
    }
  }

  const warnings: string[] = [];
  if (images.length === 0) {
    warnings.push(
      `SearXNG returned no usable image results for "${query}". The instance may have the ` +
        'images category disabled, or its image backends are rate-limited right now.',
    );
  }

  return { query, engine: 'searxng', baseURL, count: images.length, images, warnings };
}
