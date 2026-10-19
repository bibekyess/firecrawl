import axios, { AxiosError } from "axios";
import { decode as decodeHtmlEntities } from "he";
import { config } from "../../config";
import {
  SearchResultType,
  SearchV2Response,
  WebSearchResult,
} from "../../lib/entities";
import { logger } from "../../lib/logger";

const BRAVE_API_BASE = "https://api.search.brave.com/res/v1";

// Brave returns at most 20 web results per request. Each web search is capped
// at that single request: the caller over-asks (2x limit) to survive result
// filtering, but with a paid API that buffer costs a second request.
const MAX_WEB_COUNT = 20;
const MAX_NEWS_COUNT = 50;
const MAX_IMAGES_COUNT = 100;

// Brave uses its own codes for a few languages.
const BRAVE_LANG_OVERRIDES: Record<string, string> = {
  ja: "jp",
  zh: "zh-hans",
  "zh-cn": "zh-hans",
  "zh-tw": "zh-hant",
  pt: "pt-pt",
};

interface SearchOptions {
  tbs?: string;
  lang?: string;
  country?: string;
  safe?: boolean;
  num_results: number;
  type?: SearchResultType | SearchResultType[];
  timeout?: number;
}

function toIsoDate(usDate: string): string | undefined {
  const match = usDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  const [, month, day, year] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +day > 31) return undefined;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Converts a Google-style `tbs` value (qdr:d, cdr:1,cd_min:...,cd_max:...)
 * to Brave's `freshness` parameter. Returns undefined when there is no
 * equivalent, in which case no freshness filter is applied.
 */
export function tbsToBraveFreshness(tbs?: string): string | undefined {
  if (!tbs) return undefined;

  const qdrMatch =
    tbs.match(/(?:^|,)qdr:([hdwmy])(\d*)/) ?? tbs.match(/^([dwmy])$/);
  if (qdrMatch) {
    const unit = qdrMatch[1];
    const count = parseInt(qdrMatch[2] ?? "", 10);
    // Multi-unit windows (e.g. qdr:m6) become an explicit date range. Brave
    // has no sub-day window, so hours widen to the past day.
    if (count > 1 && unit !== "h") {
      const today = new Date();
      const from = new Date(today);
      if (unit === "d") from.setUTCDate(from.getUTCDate() - count);
      if (unit === "w") from.setUTCDate(from.getUTCDate() - count * 7);
      if (unit === "m") from.setUTCMonth(from.getUTCMonth() - count);
      if (unit === "y") from.setUTCFullYear(from.getUTCFullYear() - count);
      return `${from.toISOString().slice(0, 10)}to${today.toISOString().slice(0, 10)}`;
    }
    return { h: "pd", d: "pd", w: "pw", m: "pm", y: "py" }[unit];
  }

  if (tbs.includes("cdr:1")) {
    const min = tbs.match(/cd_min:([^,]+)/)?.[1];
    const max = tbs.match(/cd_max:([^,]+)/)?.[1];
    const from = min ? toIsoDate(min) : undefined;
    const to = max ? toIsoDate(max) : new Date().toISOString().slice(0, 10);
    if (from && to) return `${from}to${to}`;
  }

  return undefined;
}

// Never log the AxiosError itself: its request config carries the API key.
function describeBraveError(error: unknown) {
  if (error instanceof AxiosError) {
    return {
      status: error.response?.status,
      code: error.code,
      message: error.message,
      data: error.response?.data,
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

// Brave reports which parameter failed validation in error.meta.errors[].loc.
function isLocaleRejection(error: unknown): boolean {
  if (!(error instanceof AxiosError) || error.response?.status !== 422) {
    return false;
  }
  const errors: any[] = error.response.data?.error?.meta?.errors ?? [];
  return errors.some(
    e =>
      Array.isArray(e?.loc) &&
      (e.loc.includes("search_lang") || e.loc.includes("country")),
  );
}

function buildCommonParams(
  q: string,
  options: SearchOptions,
  withLocale: boolean,
): Record<string, string | number> {
  const params: Record<string, string | number> = { q };
  if (withLocale) {
    if (options.lang) {
      const lang = options.lang.toLowerCase();
      params.search_lang = BRAVE_LANG_OVERRIDES[lang] ?? lang;
    }
    if (options.country) params.country = options.country.toUpperCase();
  }
  if (options.safe) params.safesearch = "strict";
  const freshness = tbsToBraveFreshness(options.tbs);
  if (freshness) params.freshness = freshness;
  return params;
}

async function braveGet(
  endpoint: "web" | "news" | "images",
  q: string,
  options: SearchOptions,
  extraParams: Record<string, string | number>,
): Promise<any> {
  const request = (withLocale: boolean) =>
    axios.get(`${BRAVE_API_BASE}/${endpoint}/search`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": config.BRAVE_API_KEY!,
      },
      params: { ...buildCommonParams(q, options, withLocale), ...extraParams },
      timeout: options.timeout,
    });

  try {
    return (await request(true)).data;
  } catch (error) {
    // Brave rejects language/country codes it doesn't support with a 422.
    // Retry once without them rather than losing the whole search.
    if (isLocaleRejection(error)) {
      logger.warn("Brave rejected search locale, retrying without it", {
        lang: options.lang,
        country: options.country,
      });
      return (await request(false)).data;
    }
    throw error;
  }
}

async function searchWeb(
  q: string,
  options: SearchOptions,
): Promise<WebSearchResult[]> {
  const data = await braveGet("web", q, options, {
    count: Math.min(options.num_results, MAX_WEB_COUNT),
    text_decorations: "false",
  });
  const results: any[] = data?.web?.results ?? [];
  return results.map(r => ({
    url: r.url,
    title: decodeHtmlEntities(r.title ?? ""),
    description: decodeHtmlEntities(r.description ?? ""),
  }));
}

async function searchNews(q: string, options: SearchOptions) {
  const data = await braveGet("news", q, options, {
    count: Math.min(options.num_results, MAX_NEWS_COUNT),
    text_decorations: "false",
  });
  const results: any[] = data?.results ?? [];
  return results.map((r, i) => ({
    title: r.title && decodeHtmlEntities(r.title),
    url: r.url,
    snippet: r.description && decodeHtmlEntities(r.description),
    date: r.age ?? r.page_age,
    imageUrl: r.thumbnail?.src,
    position: i + 1,
  }));
}

async function searchImages(q: string, options: SearchOptions) {
  const data = await braveGet("images", q, options, {
    count: Math.min(options.num_results, MAX_IMAGES_COUNT),
  });
  const results: any[] = data?.results ?? [];
  return results.map((r, i) => ({
    title: r.title && decodeHtmlEntities(r.title),
    imageUrl: r.properties?.url ?? r.thumbnail?.src,
    imageWidth: r.properties?.width,
    imageHeight: r.properties?.height,
    url: r.url,
    position: i + 1,
  }));
}

export async function brave_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  if (options.num_results <= 0) return {};

  const types = new Set<SearchResultType>(
    options.type === undefined
      ? ["web"]
      : Array.isArray(options.type)
        ? options.type.length > 0
          ? options.type
          : ["web"]
        : [options.type],
  );

  // Each type is a separate Brave request; one failing (e.g. a plan without
  // news access) shouldn't drop the others.
  const run = async <T>(type: SearchResultType, fn: () => Promise<T[]>) => {
    if (!types.has(type)) return undefined;
    try {
      const results = await fn();
      return results.length > 0 ? results : undefined;
    } catch (error) {
      logger.error("Brave search request failed", {
        type,
        ...describeBraveError(error),
      });
      return undefined;
    }
  };

  const [web, news, images] = await Promise.all([
    run("web", () => searchWeb(q, options)),
    run("news", () => searchNews(q, options)),
    run("images", () => searchImages(q, options)),
  ]);

  const response: SearchV2Response = {};
  if (web) response.web = web;
  if (news) response.news = news;
  if (images) response.images = images;
  return response;
}
