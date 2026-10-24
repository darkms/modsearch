import { describe, expect, it, vi } from 'vitest';
import {
  buildImageSearchUrl,
  normalizeImageUrl,
  parseResolution,
  resolveSearxngBaseURL,
  searchImages,
} from './images.ts';

const BASE = 'https://searx.example';

/** A fetcher that answers with a canned body, so no test touches the network. */
function fetcherReturning(body: unknown, status = 200) {
  return vi.fn(async (_options: { url: string; allowPrivateNetwork?: boolean }) => ({
    status,
    statusText: status === 200 ? 'OK' : 'Server Error',
    text: typeof body === 'string' ? body : JSON.stringify(body),
    finalUrl: `${BASE}/search`,
  }));
}

/** One SearXNG image hit, in the shape the instance actually returns. */
function hit(overrides: Record<string, unknown> = {}) {
  return {
    title: 'A cat',
    img_src: 'https://cdn.example/cat.jpg',
    thumbnail_src: 'https://cdn.example/cat_thumb.jpg',
    url: 'https://page.example/cat',
    source: 'page.example',
    engine: 'bing images',
    resolution: '1920×1080',
    ...overrides,
  };
}

describe('resolveSearxngBaseURL', () => {
  it('prefers the flag, then config, then the environment', () => {
    const config = { engines: { searxng: { baseURL: 'https://from-config.example' } } };
    expect(resolveSearxngBaseURL('https://from-flag.example', config, {})).toBe(
      'https://from-flag.example',
    );
    expect(resolveSearxngBaseURL(undefined, config, {})).toBe('https://from-config.example');
    expect(resolveSearxngBaseURL(undefined, {}, { SEARXNG_BASE_URL: 'https://from-env.example' })).toBe(
      'https://from-env.example',
    );
  });

  it('strips trailing slashes so the appended path stays single', () => {
    expect(resolveSearxngBaseURL('https://searx.example/', {}, {})).toBe('https://searx.example');
    expect(resolveSearxngBaseURL('https://searx.example///', {}, {})).toBe('https://searx.example');
  });

  it('names the setting when nothing is configured', () => {
    expect(() => resolveSearxngBaseURL(undefined, {}, {})).toThrow(/engines\.searxng\.baseURL/);
  });

  it('rejects a value that is not an http(s) URL', () => {
    expect(() => resolveSearxngBaseURL('searx.example', {}, {})).toThrow(/not a valid/i);
    expect(() => resolveSearxngBaseURL('ftp://searx.example', {}, {})).toThrow(/http\(s\)/i);
  });
});

describe('buildImageSearchUrl', () => {
  it('asks for the images category as JSON', () => {
    const url = new URL(buildImageSearchUrl(BASE, 'cute cat'));
    expect(url.origin + url.pathname).toBe(`${BASE}/search`);
    expect(url.searchParams.get('q')).toBe('cute cat');
    expect(url.searchParams.get('categories')).toBe('images');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('keeps a reverse-proxy prefix in front of the path', () => {
    const url = new URL(buildImageSearchUrl('https://host/searx', 'cat'));
    expect(url.pathname).toBe('/searx/search');
  });
});

describe('normalizeImageUrl', () => {
  it('absolute-izes the protocol-relative hits SearXNG emits', () => {
    expect(normalizeImageUrl('//live.staticflickr.com/1/x.jpg')).toBe(
      'https://live.staticflickr.com/1/x.jpg',
    );
  });

  it('drops everything that is not a usable http(s) image reference', () => {
    expect(normalizeImageUrl('')).toBeUndefined();
    expect(normalizeImageUrl('   ')).toBeUndefined();
    expect(normalizeImageUrl(undefined)).toBeUndefined();
    expect(normalizeImageUrl(42)).toBeUndefined();
    expect(normalizeImageUrl('data:image/png;base64,AAAA')).toBeUndefined();
    expect(normalizeImageUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeImageUrl('not a url')).toBeUndefined();
  });
});

describe('parseResolution', () => {
  it('reads the multiplication sign and the plain x', () => {
    expect(parseResolution('1920×1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseResolution('800x450')).toEqual({ width: 800, height: 450 });
  });

  it('returns nothing for a value it cannot parse', () => {
    expect(parseResolution('')).toEqual({});
    expect(parseResolution(undefined)).toEqual({});
    expect(parseResolution('huge')).toEqual({});
  });
});

describe('searchImages', () => {
  const config = { engines: { searxng: { baseURL: BASE } } };

  it('normalizes hits into the envelope', async () => {
    const fetcher = fetcherReturning({ query: 'cat', results: [hit()] });
    const result = await searchImages({ query: '  cat  ', config, fetcher });

    expect(result).toMatchObject({
      query: 'cat',
      engine: 'searxng',
      baseURL: BASE,
      count: 1,
    });
    expect(result.images[0]).toEqual({
      title: 'A cat',
      imageUrl: 'https://cdn.example/cat.jpg',
      thumbnailUrl: 'https://cdn.example/cat_thumb.jpg',
      pageUrl: 'https://page.example/cat',
      source: 'page.example',
      engine: 'bing images',
      width: 1920,
      height: 1080,
    });
    expect(result.warnings).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('drops hits without an image and duplicate image URLs', async () => {
    const fetcher = fetcherReturning({
      results: [
        hit({ img_src: 'https://cdn.example/a.jpg' }),
        hit({ img_src: 'https://cdn.example/a.jpg' }),
        { title: 'no image here', img_src: '', thumbnail_src: '' },
      ],
    });
    const result = await searchImages({ query: 'cat', config, fetcher });

    expect(result.count).toBe(1);
    expect(result.images[0].imageUrl).toBe('https://cdn.example/a.jpg');
  });

  it('honours maxResults', async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      hit({ img_src: `https://cdn.example/${i}.jpg` }),
    );
    const result = await searchImages({ query: 'cat', maxResults: 3, config, fetcher: fetcherReturning({ results }) });

    expect(result.count).toBe(3);
  });

  it('warns instead of failing when the instance has no usable hits', async () => {
    const result = await searchImages({
      query: 'cat',
      config,
      fetcher: fetcherReturning({ results: [] }),
    });

    expect(result.images).toEqual([]);
    expect(result.warnings[0]).toMatch(/no usable image results/i);
  });

  it('passes the private-network policy through to the fetcher', async () => {
    const fetcher = fetcherReturning({ results: [hit()] });
    await searchImages({ query: 'cat', config, fetcher, allowPrivateNetwork: true });
    expect(fetcher.mock.calls[0][0]).toMatchObject({ allowPrivateNetwork: true });

    const second = fetcherReturning({ results: [hit()] });
    await searchImages({ query: 'cat', config, fetcher: second });
    expect(second.mock.calls[0][0]).toMatchObject({ allowPrivateNetwork: false });
  });

  it('takes the policy from config when the flag is absent', async () => {
    const fetcher = fetcherReturning({ results: [hit()] });
    await searchImages({
      query: 'cat',
      config: { ...config, allowPrivateNetwork: true },
      fetcher,
    });
    expect(fetcher.mock.calls[0][0]).toMatchObject({ allowPrivateNetwork: true });
  });

  it('throws with the instance name on a non-2xx answer', async () => {
    await expect(
      searchImages({ query: 'cat', config, fetcher: fetcherReturning({}, 500) }),
    ).rejects.toThrow(/SearXNG at https:\/\/searx\.example answered 500/);
  });

  it('explains the JSON-format switch when the instance answers HTML', async () => {
    await expect(
      searchImages({ query: 'cat', config, fetcher: fetcherReturning('<html>ui</html>') }),
    ).rejects.toThrow(/search\.formats must include json/);
  });

  it('refuses an empty query before any request', async () => {
    const fetcher = fetcherReturning({ results: [] });
    await expect(searchImages({ query: '   ', config, fetcher })).rejects.toThrow(
      /non-empty query/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
