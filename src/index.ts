import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// --- Helpers ---

const API_BASE = "https://darak.app";

const CITY_ENUM = ["riyadh", "jeddah", "eastern_province", "makkah", "madinah"] as const;

const CITY_SLUG_TO_NAME: Record<string, string> = {
  riyadh: "Riyadh",
  jeddah: "Jeddah",
  eastern_province: "Eastern Province",
  makkah: "Makkah",
  madinah: "Madinah",
};

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(path, API_BASE);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function callApi(url: string): Promise<unknown> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      return { error: `API returned ${res.status}: ${text}` };
    }
    return res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to reach API: ${message}` };
  }
}

/** Replace source_url with darak.app listing URL on any object with an `id` field */
function rewriteUrls(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(rewriteUrls);

  const obj = data as Record<string, unknown>;

  // Single listing object — has id + source_url
  if (typeof obj.id === "number" && "source_url" in obj) {
    const { source_url: _, ...rest } = obj;
    return { ...rest, url: `https://darak.app/listing/${obj.id}` };
  }

  // Paginated response — rewrite nested arrays (listings, comparables, etc.)
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    rewritten[key] = Array.isArray(value) ? value.map(rewriteUrls) : value;
  }
  return rewritten;
}

function trackToolCall(toolName: string, params: Record<string, unknown>, isError: boolean) {
  // Fire-and-forget PostHog event via HTTP API
  const token = (typeof process !== "undefined" && process.env?.POSTHOG_PROJECT_TOKEN) || "";
  if (!token) return;
  fetch("https://us.i.posthog.com/capture/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: token,
      event: "mcp_tool_called",
      distinct_id: "mcp-server",
      properties: {
        tool: toolName,
        city: params.city ?? null,
        listing_type: params.listing_type ?? null,
        is_error: isError,
      },
    }),
  }).catch(() => {});
}

/** Fetch an image and return as a data URI string. Returns null on failure. */
async function fetchImageDataUri(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(5_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Darak/1.0)" },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/**
 * Inject thumbnail_b64 data URIs into listing objects so Claude can use them
 * in widget <img src> tags (artifacts CSP allows data: URIs).
 * Mutates listing objects in place. Fetches up to `max` thumbnails in parallel.
 */
async function injectThumbnails(data: unknown, max: number): Promise<void> {
  if (!data || typeof data !== "object") return;
  const obj = data as Record<string, unknown>;

  // Collect listings to process
  let listings: Record<string, unknown>[] = [];

  // Single listing
  if (Array.isArray(obj.images) && typeof obj.id === "number") {
    listings = [obj];
  }
  // Paginated response
  else if (Array.isArray(obj.listings)) {
    listings = (obj.listings as Record<string, unknown>[]).slice(0, max);
  }

  if (listings.length === 0) return;

  const tasks = listings.map(async (listing) => {
    const imgs = listing.images;
    if (Array.isArray(imgs) && imgs.length > 0) {
      const dataUri = await fetchImageDataUri(imgs[0] as string);
      if (dataUri) {
        listing.thumbnail_b64 = dataUri;
      }
    }
  });

  await Promise.all(tasks);
}

function textResult(toolName: string, data: unknown, params: Record<string, unknown> = {}) {
  const rewritten = rewriteUrls(data);
  const isError = !!(rewritten && typeof rewritten === "object" && "error" in rewritten);
  trackToolCall(toolName, params, isError);
  if (isError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rewritten, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(rewritten, null, 2) }],
  };
}

/** Max thumbnails per request (CF Workers allows 50 subrequests; 1 for API call, 49 for images). */
const MAX_THUMBNAILS = 49;

/**
 * Like textResult but injects thumbnail_b64 data URIs into listing objects.
 * Claude can then use these in widget <img src="..."> tags.
 * Only fetches thumbnails when includeThumbnails is true.
 */
async function resultWithThumbnails(
  toolName: string,
  data: unknown,
  params: Record<string, unknown> = {},
  includeThumbnails = false,
) {
  const rewritten = rewriteUrls(data);
  const isError = !!(rewritten && typeof rewritten === "object" && "error" in rewritten);
  trackToolCall(toolName, params, isError);

  if (isError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rewritten, null, 2) }],
      isError: true,
    };
  }

  if (includeThumbnails) {
    await injectThumbnails(rewritten, MAX_THUMBNAILS);
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(rewritten, null, 2) }],
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;

// --- MCP Agent ---

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "darak",
    version: "1.0.0",
  });

  async init() {
    // --- Search & Listings ---

    this.server.tool(
      "search_listings",
      "Search Saudi rental or sale property listings with filters. Returns paginated results. Prices are in SAR. IMPORTANT: When filtering by neighborhood, you MUST first call list_neighborhoods to get the exact English name. Do not guess neighborhood names.",
      {
        city: z.enum(CITY_ENUM).optional().default("riyadh").describe("City to search"),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent").describe("Rent or sale"),
        property_type: z.enum(["apartment", "villa", "all"]).optional().describe("Property type ('all' = no filter)"),
        price_min: z.number().optional().describe("Minimum price in SAR"),
        price_max: z.number().optional().describe("Maximum price in SAR"),
        beds: z.number().optional().describe("Minimum number of bedrooms"),
        neighborhood: z.string().optional().describe("Neighborhood name(s), comma-separated. Use list_neighborhoods to get valid names."),
        amenities: z.string().optional().describe("Comma-separated: ac, kitchen, maid_room, parking, private_roof, lift, pool"),
        furnished: z.boolean().optional().describe("Filter by furnished status"),
        area_min: z.number().optional().describe("Minimum area in sqm"),
        area_max: z.number().optional().describe("Maximum area in sqm"),
        bathrooms: z.number().optional().describe("Minimum bathrooms"),
        floor: z.enum(["ground", "upper"]).optional().describe("Floor preference"),
        source: z.string().optional().describe("Data source name(s), comma-separated"),
        max_age: z.number().optional().describe("Max building age in years"),
        updated_within: z.enum(["3d", "1w", "1m"]).optional().describe("Only listings updated within this period"),
        verified: z.boolean().optional().describe("Filter by verified listings only"),
        advertiser_type: z.enum(["owner", "agent", "developer"]).optional().describe("Filter by advertiser type"),
        compound: z.string().optional().describe("Filter by compound/community name (partial match)"),
        duplex: z.boolean().optional().describe("Filter for duplex units"),
        livings: z.number().optional().describe("Minimum number of living rooms"),
        sort: z.enum([
          "relevance", "price_asc", "price_desc", "area_desc", "newest",
          "price_per_sqm_asc", "price_per_sqm_desc", "best_value",
          "bedrooms_desc", "oldest_listing", "recently_updated",
        ]).optional().default("relevance").describe("Sort order"),
        page: z.number().optional().default(1).describe("Page number"),
        page_size: z.number().optional().describe("Results per page (max 100). Defaults to 12 when include_thumbnails is true, 30 otherwise."),
        include_thumbnails: z.boolean().optional().default(false).describe("Include base64 thumbnail_b64 data URI on each listing for use in widget <img> tags. Defaults page_size to 12 when enabled."),
      },
      READ_ONLY,
      async (params) => {
        const pageSize = params.page_size ?? (params.include_thumbnails ? 12 : 30);
        return resultWithThumbnails("search_listings", await callApi(buildUrl("/api/listings", {
          city: params.city, listing_type: params.listing_type, property_type: params.property_type,
          price_min: params.price_min, price_max: params.price_max, beds: params.beds,
          neighborhood: params.neighborhood, amenities: params.amenities, furnished: params.furnished,
          area_min: params.area_min, area_max: params.area_max, bathrooms: params.bathrooms,
          floor: params.floor, source: params.source, max_age: params.max_age,
          updated_within: params.updated_within, verified: params.verified,
          advertiser_type: params.advertiser_type, compound: params.compound,
          duplex: params.duplex, livings: params.livings,
          sort: params.sort, page: params.page, page_size: pageSize,
        })), params, params.include_thumbnails);
      },
    );

    this.server.tool(
      "get_listing",
      "Get full details for a specific property listing by its ID.",
      {
        id: z.number().describe("Listing ID"),
        include_thumbnails: z.boolean().optional().default(false).describe("Include base64 thumbnail_b64 data URI for use in widget <img> tags."),
      },
      READ_ONLY,
      async ({ id, include_thumbnails }) => resultWithThumbnails("get_listing", await callApi(buildUrl(`/api/listings/${id}`)), {}, include_thumbnails),
    );

    this.server.tool(
      "get_comparable_listings",
      "Find similar nearby listings for price comparison. Returns listings within ~5km with same property type and similar bedroom count (+/-1).",
      {
        id: z.number().describe("Listing ID to find comparables for"),
        limit: z.number().optional().describe("Max results (max 100). Defaults to 12 when include_thumbnails is true, 50 otherwise."),
        include_thumbnails: z.boolean().optional().default(false).describe("Include base64 thumbnail_b64 data URI on each listing for use in widget <img> tags. Defaults limit to 12 when enabled."),
      },
      READ_ONLY,
      async (params) => {
        const limit = params.limit ?? (params.include_thumbnails ? 12 : 50);
        return resultWithThumbnails("get_comparable_listings", await callApi(buildUrl("/api/listing-comparables", { id: params.id, limit })), params, params.include_thumbnails);
      },
    );

    this.server.tool(
      "get_price_history",
      "Get price change history for a listing. Shows how the price evolved over time, total price change percentage, and days on market.",
      {
        id: z.number().describe("Listing ID"),
        limit: z.number().optional().default(50).describe("Max history records (max 200)"),
      },
      READ_ONLY,
      async (params) => textResult("get_price_history", await callApi(buildUrl("/api/price-history", { id: params.id, limit: params.limit }))),
    );

    this.server.tool(
      "get_best_value_listings",
      "Find listings priced below their neighborhood median — best deals. Returns listings sorted by discount percentage (biggest savings first). When filtering by neighborhood, call list_neighborhoods first to get exact English names.",
      {
        city: z.enum(CITY_ENUM).optional().default("riyadh"),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
        property_type: z.enum(["apartment", "villa", "all"]).optional(),
        neighborhood: z.string().optional().describe("Neighborhood name(s), comma-separated"),
        beds: z.number().optional().describe("Minimum bedrooms"),
        limit: z.number().optional().describe("Max results (max 100). Defaults to 12 when include_thumbnails is true, 30 otherwise."),
        include_thumbnails: z.boolean().optional().default(false).describe("Include base64 thumbnail_b64 data URI on each listing for use in widget <img> tags. Defaults limit to 12 when enabled."),
      },
      READ_ONLY,
      async (params) => {
        const limit = params.limit ?? (params.include_thumbnails ? 12 : 30);
        return resultWithThumbnails("get_best_value_listings", await callApi(buildUrl("/api/best-value", {
          city: params.city, listing_type: params.listing_type, property_type: params.property_type,
          neighborhood: params.neighborhood, beds: params.beds, limit,
        })), params, params.include_thumbnails);
      },
    );

    // --- Market Analytics ---

    this.server.tool(
      "get_price_distribution",
      "Get price distribution histogram. Returns 30 buckets with counts, plus median and mean. When filtering by neighborhood, call list_neighborhoods first to get exact English names.",
      {
        city: z.enum(CITY_ENUM).optional().default("riyadh"),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
        property_type: z.enum(["apartment", "villa", "all"]).optional(),
        neighborhood: z.string().optional().describe("Neighborhood name(s), comma-separated"),
      },
      READ_ONLY,
      async (params) => textResult("get_price_distribution", await callApi(buildUrl("/api/histogram", {
        city: params.city, listing_type: params.listing_type,
        property_type: params.property_type, neighborhood: params.neighborhood,
      })), params),
    );

    this.server.tool(
      "get_area_distribution",
      "Get area (sqm) distribution histogram. Returns 30 buckets with counts, plus median and mean. When filtering by neighborhood, call list_neighborhoods first to get exact English names.",
      {
        city: z.enum(CITY_ENUM).optional().default("riyadh"),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
        property_type: z.enum(["apartment", "villa", "all"]).optional(),
        neighborhood: z.string().optional().describe("Neighborhood name(s), comma-separated"),
      },
      READ_ONLY,
      async (params) => textResult("get_area_distribution", await callApi(buildUrl("/api/area-histogram", {
        city: params.city, listing_type: params.listing_type,
        property_type: params.property_type, neighborhood: params.neighborhood,
      })), params),
    );

    this.server.tool(
      "get_listing_market_stats",
      "Get market context for a specific listing: price/area percentiles, neighborhood comparison, and bedroom price chart.",
      { id: z.number().describe("Listing ID") },
      READ_ONLY,
      async ({ id }) => textResult("get_listing_market_stats", await callApi(buildUrl("/api/listing-stats", { id }))),
    );

    this.server.tool(
      "compare_neighborhoods",
      "Compare 2-5 neighborhoods side by side. Returns median price, area, price/sqm, price range (P25-P75), amenity percentages, property mix, and bedroom breakdown for each. IMPORTANT: Call list_neighborhoods first to get exact English names.",
      {
        city: z.enum(CITY_ENUM).optional().default("riyadh"),
        neighborhoods: z.string().describe("2-5 neighborhood English names, comma-separated. Use list_neighborhoods to get valid names."),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
        property_type: z.enum(["apartment", "villa", "all"]).optional(),
      },
      READ_ONLY,
      async (params) => textResult("compare_neighborhoods", await callApi(buildUrl("/api/neighborhood-compare", {
        city: params.city, neighborhoods: params.neighborhoods,
        listing_type: params.listing_type, property_type: params.property_type,
      })), params),
    );

    this.server.tool(
      "get_market_summary",
      "Get a high-level market overview for a city: total listings, median price, breakdown by property type, top neighborhoods, source coverage, and data freshness.",
      {
        city: z.enum(CITY_ENUM).optional().default("riyadh"),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
      },
      READ_ONLY,
      async (params) => textResult("get_market_summary", await callApi(buildUrl("/api/market-summary", {
        city: params.city, listing_type: params.listing_type,
      })), params),
    );

    this.server.tool(
      "get_neighborhood_trends",
      "Get monthly price trends for 1-5 neighborhoods over time. Returns median price, P25/P75 range, and listing count per month. Shows price_change_pct between earliest and latest month. Use to answer questions about whether prices are rising or falling in a neighborhood. IMPORTANT: Call list_neighborhoods first to get exact English names.",
      {
        city: z.enum(CITY_ENUM).optional().default("riyadh"),
        neighborhoods: z.string().describe("1-5 neighborhood English names, comma-separated. Use list_neighborhoods to get valid names."),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
        property_type: z.enum(["apartment", "villa", "all"]).optional(),
        months: z.number().optional().default(6).describe("How many months of history (max 24)"),
      },
      READ_ONLY,
      async (params) => textResult("get_neighborhood_trends", await callApi(buildUrl("/api/neighborhood-trends", {
        city: params.city, neighborhoods: params.neighborhoods,
        listing_type: params.listing_type, property_type: params.property_type,
        months: params.months,
      })), params),
    );

    // --- Geography & Navigation ---

    this.server.tool(
      "list_neighborhoods",
      "List all neighborhoods in a city with Arabic and English names.",
      { city: z.enum(CITY_ENUM).optional().default("riyadh") },
      READ_ONLY,
      async ({ city }) => textResult("list_neighborhoods", await callApi(buildUrl("/api/neighborhoods", { city })), { city }),
    );

    this.server.tool(
      "list_city_directions",
      "Get districts/directions of a city with their neighborhoods. Note: data from external API, may be slower.",
      { city: z.enum(CITY_ENUM).optional().default("riyadh") },
      READ_ONLY,
      async ({ city }) => textResult("list_city_directions", await callApi(buildUrl("/api/directions", { city })), { city }),
    );

    this.server.tool(
      "get_neighborhood_pois",
      "Get points of interest near a neighborhood. Returns up to 6 POIs sorted by distance.",
      {
        city: z.enum(CITY_ENUM).describe("City slug"),
        neighborhood: z.string().describe("Neighborhood English name (use list_neighborhoods to get valid names)"),
      },
      READ_ONLY,
      async ({ city, neighborhood }) => textResult("get_neighborhood_pois", await callApi(buildUrl("/api/neighborhood-pois", {
        city: CITY_SLUG_TO_NAME[city] ?? city, neighborhood,
      })), { city }),
    );

    this.server.tool(
      "get_map_listings",
      "Get listings within geographic bounds. Result count scales with zoom level.",
      {
        bounds: z.string().describe("Bounding box as 'south,west,north,east' coordinates"),
        zoom: z.number().optional().default(12).describe("Map zoom level"),
        listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
        property_type: z.enum(["apartment", "villa", "all"]).optional(),
        city: z.enum(CITY_ENUM).optional().default("riyadh"),
        sort: z.enum(["relevance", "price_asc", "price_desc", "area_desc", "newest"]).optional(),
      },
      READ_ONLY,
      async (params) => textResult("get_map_listings", await callApi(buildUrl("/api/map-listings", {
        bounds: params.bounds, zoom: params.zoom, listing_type: params.listing_type,
        property_type: params.property_type, city: params.city, sort: params.sort,
      })), params),
    );

    this.server.tool(
      "get_map_pois",
      "Get points of interest within geographic bounds. Returns empty if zoom < 10.",
      {
        bounds: z.string().describe("Bounding box as 'south,west,north,east' coordinates"),
        zoom: z.number().optional().default(12).describe("Map zoom level (min 10 for results)"),
      },
      READ_ONLY,
      async ({ bounds, zoom }) => textResult("get_map_pois", await callApi(buildUrl("/api/map-pois", { bounds, zoom }))),
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // Redirect root to the connect page
    if (url.pathname === "/") {
      return Response.redirect("https://darak.app/connect", 302);
    }

    return new Response("Not found", { status: 404 });
  },
};
