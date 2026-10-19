import { AxiosError, AxiosHeaders } from "axios";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  config: { BRAVE_API_KEY: "test-key" as string | undefined },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("axios", async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual, default: { ...actual.default, get: mocks.get } };
});
vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("../../lib/logger", () => ({ logger: mocks.logger }));

import { brave_search, tbsToBraveFreshness } from "./brave";

function httpError(status: number, data: unknown = {}) {
  return new AxiosError(
    `Request failed with status code ${status}`,
    String(status),
    undefined,
    undefined,
    {
      status,
      statusText: "",
      headers: {},
      config: {
        headers: new AxiosHeaders({ "X-Subscription-Token": "test-key" }),
      },
      data,
    },
  );
}

function webPage(n: number) {
  return {
    data: {
      web: {
        results: Array.from({ length: n }, (_, i) => ({
          url: `https://example.com/${i}`,
          title: `Result ${i}`,
          description: `Snippet ${i}`,
        })),
      },
    },
  };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.logger.error.mockClear();
  mocks.logger.warn.mockClear();
});

describe("tbsToBraveFreshness", () => {
  it.each([
    ["qdr:h", "pd"],
    ["qdr:d", "pd"],
    ["qdr:w", "pw"],
    ["qdr:m", "pm"],
    ["qdr:y", "py"],
    ["sbd:1,qdr:w", "pw"],
    ["cdr:1,cd_min:1/5/2024,cd_max:12/31/2024", "2024-01-05to2024-12-31"],
    ["qdr:h3", "pd"],
  ])("maps %s to %s", (tbs, expected) => {
    expect(tbsToBraveFreshness(tbs)).toBe(expected);
  });

  it("returns undefined for unknown values", () => {
    expect(tbsToBraveFreshness(undefined)).toBeUndefined();
    expect(tbsToBraveFreshness("sbd:1")).toBeUndefined();
    expect(
      tbsToBraveFreshness("cdr:1,cd_min:13/45/2024,cd_max:12/31/2024"),
    ).toBeUndefined();
  });

  describe("multi-unit windows", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());

    it.each([
      ["qdr:d3", "2026-10-16to2026-10-19"],
      ["qdr:w2", "2026-10-05to2026-10-19"],
      ["qdr:m6", "2026-04-19to2026-10-19"],
      ["qdr:y2", "2024-10-19to2026-10-19"],
    ])("maps %s to %s", (tbs, expected) => {
      expect(tbsToBraveFreshness(tbs)).toBe(expected);
    });
  });
});

describe("brave_search", () => {
  it("maps web results and sends auth and locale params", async () => {
    mocks.get.mockResolvedValueOnce(webPage(3));

    const res = await brave_search("firecrawl", {
      num_results: 3,
      lang: "ja",
      country: "jp",
      safe: true,
      tbs: "qdr:w",
    });

    expect(res.web).toEqual([
      {
        url: "https://example.com/0",
        title: "Result 0",
        description: "Snippet 0",
      },
      {
        url: "https://example.com/1",
        title: "Result 1",
        description: "Snippet 1",
      },
      {
        url: "https://example.com/2",
        title: "Result 2",
        description: "Snippet 2",
      },
    ]);
    const [url, opts] = mocks.get.mock.calls[0];
    expect(url).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(opts.headers["X-Subscription-Token"]).toBe("test-key");
    expect(opts.params).toMatchObject({
      q: "firecrawl",
      count: 3,
      search_lang: "jp",
      country: "JP",
      safesearch: "strict",
      freshness: "pw",
    });
  });

  it("makes a single web request capped at 20 results", async () => {
    mocks.get.mockResolvedValueOnce(webPage(20));

    const res = await brave_search("firecrawl", { num_results: 50 });

    expect(res.web).toHaveLength(20);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get.mock.calls[0][1].params.count).toBe(20);
    expect(mocks.get.mock.calls[0][1].params.offset).toBeUndefined();
  });

  it("retries without locale when Brave rejects it", async () => {
    mocks.get
      .mockRejectedValueOnce(
        httpError(422, {
          error: { meta: { errors: [{ loc: ["query", "search_lang"] }] } },
        }),
      )
      .mockResolvedValueOnce(webPage(2));

    const res = await brave_search("firecrawl", {
      num_results: 2,
      lang: "xx",
      country: "zz",
    });

    expect(res.web).toHaveLength(2);
    const retryParams = mocks.get.mock.calls[1][1].params;
    expect(retryParams.search_lang).toBeUndefined();
    expect(retryParams.country).toBeUndefined();
  });

  it.each([401, 429, 500])(
    "returns an empty response on HTTP %i so callers can fall back",
    async status => {
      mocks.get.mockRejectedValue(httpError(status));

      await expect(
        brave_search("firecrawl", { num_results: 5 }),
      ).resolves.toEqual({});
    },
  );

  it("does not retry a 422 unrelated to locale", async () => {
    mocks.get.mockRejectedValue(
      httpError(422, {
        error: { meta: { errors: [{ loc: ["query", "q"] }] } },
      }),
    );

    await expect(
      brave_search("firecrawl", { num_results: 5, lang: "en", country: "us" }),
    ).resolves.toEqual({});
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("never logs the API key", async () => {
    mocks.get.mockRejectedValue(httpError(401));

    await brave_search("firecrawl", { num_results: 5 });

    expect(mocks.logger.error).toHaveBeenCalled();
    const logged = JSON.stringify([
      ...mocks.logger.error.mock.calls,
      ...mocks.logger.warn.mock.calls,
    ]);
    expect(logged).not.toContain("test-key");
    expect(logged).toContain("401");
  });

  it("requests plain-text snippets and decodes HTML entities", async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        web: {
          results: [
            {
              url: "https://example.com/",
              title: "Rock &amp; Roll",
              description: "It&#x27;s here",
            },
          ],
        },
      },
    });

    const res = await brave_search("firecrawl", { num_results: 1 });

    expect(mocks.get.mock.calls[0][1].params.text_decorations).toBe("false");
    expect(res.web?.[0]).toMatchObject({
      title: "Rock & Roll",
      description: "It's here",
    });
  });

  it("keeps successful types when another type fails", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/news/search")) throw httpError(403);
      return webPage(2);
    });

    const res = await brave_search("firecrawl", {
      num_results: 2,
      type: ["web", "news"],
    });

    expect(res.web).toHaveLength(2);
    expect(res.news).toBeUndefined();
  });

  it("maps news and image results", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/news/search")) {
        return {
          data: {
            results: [
              {
                title: "News",
                url: "https://news.example/a",
                description: "Story",
                age: "2 hours ago",
                thumbnail: { src: "https://img.example/t.jpg" },
              },
            ],
          },
        };
      }
      return {
        data: {
          results: [
            {
              title: "Image",
              url: "https://page.example/",
              properties: {
                url: "https://img.example/full.jpg",
                width: 800,
                height: 600,
              },
            },
          ],
        },
      };
    });

    const res = await brave_search("firecrawl", {
      num_results: 1,
      type: ["news", "images"],
    });

    expect(res.web).toBeUndefined();
    expect(res.news).toEqual([
      {
        title: "News",
        url: "https://news.example/a",
        snippet: "Story",
        date: "2 hours ago",
        imageUrl: "https://img.example/t.jpg",
        position: 1,
      },
    ]);
    expect(res.images).toEqual([
      {
        title: "Image",
        imageUrl: "https://img.example/full.jpg",
        imageWidth: 800,
        imageHeight: 600,
        url: "https://page.example/",
        position: 1,
      },
    ]);
  });
});
