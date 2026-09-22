import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// --- Helpers ---

// The public, versioned, metered API — not darak.app's internal routes. Every
// call carries a key, so MCP traffic lands in the same request log, usage
// rollup and dashboards as any other API consumer.
const DEFAULT_API_BASE = "https://api.darak.app/v1";

/**
 * Where a client goes to sign in; this server only consumes the result.
 *
 * It must be the issuer exactly as the discovery document states it
 * (RFC 8414 §3.3), not the path the endpoints happen to live under: a client
 * fetches `<issuer>/.well-known/oauth-authorization-server` and rejects the
 * result if the `issuer` inside does not match what it asked for.
 */
const AUTHORIZATION_SERVER = "https://darak.app";

/** The token from `Authorization: Bearer <token>`, or "" when absent. */
function bearerFrom(header: string | null): string {
	const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
	return m ? m[1].trim() : "";
}

const CITY_ENUM = ["riyadh", "jeddah", "eastern_province", "makkah", "madinah"] as const;

const PROPERTY_TYPE_ENUM = [
	"apartment",
	"villa",
	"land",
	"building",
	"office",
	"shop",
	"warehouse",
	"floor",
	"duplex",
	"all",
] as const;

function buildUrl(
	path: string,
	params?: Record<string, string | number | boolean | undefined>,
	base: string = DEFAULT_API_BASE,
): string {
	// Concatenated, not `new URL(path, base)`: the base carries the `/v1` prefix
	// and a root-relative path would replace it rather than extend it.
	const url = new URL(`${base.replace(/\/$/, "")}${path}`);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") {
				url.searchParams.set(key, String(value));
			}
		}
	}
	return url.toString();
}

async function callApi(url: string, apiKey?: string): Promise<unknown> {
	try {
		const res = await fetch(url, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		});
		if (!res.ok) {
			const text = await res.text();
			console.error(
				JSON.stringify({
					message: "API error",
					url,
					status: res.status,
					body: text.slice(0, 500),
				}),
			);
			// v1 already answers with { error: { type, code, message, ... } }, which
			// is the shape the tool result checks for. Pass it through so the model
			// reads "monthly quota exceeded" rather than a stringified blob.
			try {
				const body = JSON.parse(text) as { error?: unknown };
				if (body && typeof body === "object" && body.error) return body;
			} catch {
				// Not JSON — fall through to the generic message.
			}
			return { error: `API returned ${res.status}: ${text}` };
		}
		return res.json();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(JSON.stringify({ message: "API fetch failed", url, error: message }));
		return { error: `Failed to reach API: ${message}` };
	}
}

/**
 * Who is calling, as far as an anonymous server can tell: a salted hash of the
 * IP (stable per caller, never an address), the MCP client's name, and the
 * session. Without this every call looked the same in PostHog
 * (distinct_id "mcp-server"), so somebody pulling data for their own product
 * was indistinguishable from somebody asking Claude a question.
 */
export interface CallerProps {
	ipHash: string;
	userAgent: string;
	sessionId: string;
	/**
	 * The caller's OAuth access token, when they have connected an account.
	 * Forwarded to the API unchanged: this server is a resource server, not an
	 * authorization server, so it never mints or inspects credentials. Empty
	 * for an anonymous session, which falls back to the shared service key.
	 */
	accessToken: string;
}

export async function hashIp(ip: string, salt: string): Promise<string> {
	const bytes = new TextEncoder().encode(`${salt}:${ip}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Rows returned, so asking for a few listings is told apart from pulling pages of them. */
export function countResults(data: unknown): number | null {
	if (!data || typeof data !== "object") return null;
	if (Array.isArray(data)) return data.length;
	const obj = data as Record<string, unknown>;
	for (const key of ["listings", "data", "results", "units", "projects", "neighborhoods"]) {
		if (Array.isArray(obj[key])) return (obj[key] as unknown[]).length;
	}
	return null;
}

function trackToolCall(
	toolName: string,
	params: Record<string, unknown>,
	isError: boolean,
	ctx: DurableObjectState,
	env: Env,
	caller: Partial<CallerProps>,
	client: { name?: string; version?: string } | undefined,
	results: number | null,
) {
	const token = env.POSTHOG_PROJECT_TOKEN;
	if (!token) return;
	const host = env.POSTHOG_HOST || "https://us.i.posthog.com";
	ctx.waitUntil(
		fetch(`${host}/capture/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				api_key: token,
				event: "mcp_tool_called",
				// One person per caller, so usage per builder is visible.
				distinct_id: caller.ipHash || "mcp-anonymous",
				properties: {
					tool: toolName,
					city: params.city ?? null,
					listing_type: params.listing_type ?? null,
					is_error: isError,
					results,
					limit: params.limit ?? null,
					page: params.page ?? null,
					client_name: client?.name ?? null,
					client_version: client?.version ?? null,
					session_id: caller.sessionId || null,
					user_agent: caller.userAgent || null,
				},
			}),
		}).catch(() => {}),
	);
}

function textResult(
	toolName: string,
	data: unknown,
	params: Record<string, unknown>,
	ctx: DurableObjectState,
	env: Env,
	caller: Partial<CallerProps>,
	client: { name?: string; version?: string } | undefined,
) {
	// v1 already serialises `url` as the darak.app listing page and nests the
	// source ad under `source.url`, so the payload is passed through as-is.
	const isError = !!(data && typeof data === "object" && "error" in data);
	trackToolCall(toolName, params, isError, ctx, env, caller, client, countResults(data));
	if (isError) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
			isError: true,
		};
	}
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

/** The API has no "all" — the filter is simply absent. */
function concrete(propertyType?: string): string | undefined {
	return propertyType && propertyType !== "all" ? propertyType : undefined;
}

/** The site thinks in windows ("updated in the last week"), the API in instants. */
function sinceFrom(window?: "3d" | "1w" | "1m"): string | undefined {
	if (!window) return undefined;
	const days = window === "3d" ? 3 : window === "1w" ? 7 : 30;
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;

// --- MCP Agent ---

export class MyMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "darak",
		version: "1.0.0",
	});

	async init() {
		const result = (toolName: string, data: unknown, params: Record<string, unknown> = {}) =>
			textResult(
				toolName,
				data,
				params,
				this.ctx,
				this.env,
				(this.props ?? {}) as Partial<CallerProps>,
				this.server.server.getClientVersion(),
			);

		// Every tool reaches the API through here, so the base URL and the key are
		// decided in one place rather than at 26 call sites.
		const api = (
			path: string,
			params?: Record<string, string | number | boolean | undefined>,
		) =>
			callApi(
				buildUrl(path, params, this.env.DARAK_API_BASE),
				// A connected caller acts as themselves and is metered to their
				// own organization; anonymous sessions share the service key.
				(this.props as Partial<CallerProps> | undefined)?.accessToken ||
					this.env.DARAK_API_KEY,
			);

		// --- Search & Listings ---

		this.server.registerTool(
			"search_listings",
			{
				description:
					"Search Saudi rental or sale property listings with filters. Returns paginated results with full listing details (price, beds, area, neighborhood, images, URL). Prices are in SAR. For commercial properties (office, shop, warehouse), set listing_category to 'commercial'. IMPORTANT: When filtering by neighborhood, you MUST first call list_neighborhoods to get its id. Do not guess ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh").describe("City to search"),
					listing_type: z
						.enum(["rent", "sale"])
						.optional()
						.default("rent")
						.describe("Rent or sale"),
					listing_category: z
						.enum(["residential", "commercial"])
						.optional()
						.default("residential")
						.describe(
							"Property category. Use 'commercial' when searching for office, shop, or warehouse. Use 'residential' (default) for apartment, villa, duplex, floor.",
						),
					property_type: z
						.enum(PROPERTY_TYPE_ENUM)
						.optional()
						.describe(
							"Property type: apartment, villa, land, building, office, shop, warehouse, floor, duplex, or 'all' for no filter",
						),
					price_min: z.number().optional().describe("Minimum price in SAR"),
					price_max: z.number().optional().describe("Maximum price in SAR"),
					beds: z.number().optional().describe("Exact number of bedrooms (0 = studio)"),
					beds_min: z.number().optional().describe("Minimum bedrooms, e.g. 5 for '5+'"),
					beds_max: z.number().optional().describe("Maximum bedrooms"),
					neighborhood_id: z
						.string()
						.optional()
						.describe(
							"Neighborhood id(s), comma-separated. Call list_neighborhoods first to get ids.",
						),
					neighborhood_id_exclude: z
						.string()
						.optional()
						.describe("Exclude these neighborhood ids, comma-separated."),
					amenities: z
						.string()
						.optional()
						.describe(
							"Comma-separated: ac, kitchen, maid_room, parking, private_roof, lift, pool, gym, fiber, keyless_entry, balcony, garden, laundry_room",
						),
					amenities_exclude: z
						.string()
						.optional()
						.describe(
							"Exclude listings with these amenities, comma-separated (same values as amenities param)",
						),
					furnished: z.boolean().optional().describe("Filter by furnished status"),
					area_min: z.number().optional().describe("Minimum area in sqm"),
					area_max: z.number().optional().describe("Maximum area in sqm"),
					bathrooms: z.number().optional().describe("Exact number of bathrooms"),
					bathrooms_min: z
						.number()
						.optional()
						.describe("Minimum bathrooms, e.g. 4 for '4+'"),
					floor: z.enum(["ground", "upper"]).optional().describe("Floor preference"),
					source: z.string().optional().describe("Data source name(s), comma-separated"),
					source_exclude: z
						.string()
						.optional()
						.describe("Exclude these data sources, comma-separated"),
					max_age: z.number().optional().describe("Max building age in years"),
					updated_within: z
						.enum(["3d", "1w", "1m"])
						.optional()
						.describe("Only listings updated within this period"),
					verified: z.boolean().optional().describe("Filter by verified listings only"),
					advertiser_type: z
						.enum(["company", "individual"])
						.optional()
						.describe(
							"Who posted the ad. Listings by an intermediary who does not say whether they are a firm or a person match neither.",
						),
					compound: z
						.string()
						.optional()
						.describe("Filter by compound/community name (partial match)"),
					q: z
						.string()
						.optional()
						.describe(
							'Search listing descriptions and titles. Supports: words (AND by default), quoted "phrases" for exact match, and | for OR. Examples: \'pool garden\' matches both words. \'"سكن طالبات" | "سكن موظفات"\' matches either phrase. \'"near metro"\' matches exact phrase.',
						),
					livings_min: z.number().optional().describe("Minimum number of living rooms"),
					days_on_market_min: z
						.number()
						.optional()
						.describe("Only listings on market for at least N days"),
					days_on_market_max: z
						.number()
						.optional()
						.describe("Only listings on market for at most N days"),
					sort: z
						.enum([
							"recommended",
							"newest",
							"updated_desc",
							"updated_asc",
							"price_asc",
							"price_desc",
							"price_drop",
							"days_on_market_desc",
						])
						.optional()
						.default("recommended")
						.describe(
							"Sort order. 'recommended' is Darak's own ranking and the right default for answering a question; 'price_drop' finds listings that recently reduced their price.",
						),
					cursor: z
						.string()
						.optional()
						.describe(
							"next_cursor from a previous response, to get the following page.",
						),
					limit: z.number().optional().default(30).describe("Results per page (max 100)"),
				},
				annotations: READ_ONLY,
			},
			async (params) => {
				return result(
					"search_listings",
					await api("/listings", {
						city: params.city,
						listing_type: params.listing_type,
						listing_category: params.listing_category,
						property_type: concrete(params.property_type),
						price_min: params.price_min,
						price_max: params.price_max,
						beds: params.beds,
						beds_min: params.beds_min,
						beds_max: params.beds_max,
						neighborhood_id: params.neighborhood_id,
						neighborhood_id_exclude: params.neighborhood_id_exclude,
						amenities: params.amenities,
						amenities_exclude: params.amenities_exclude,
						furnished: params.furnished,
						area_min: params.area_min,
						area_max: params.area_max,
						bathrooms: params.bathrooms,
						bathrooms_min: params.bathrooms_min,
						floor: params.floor,
						source: params.source,
						source_exclude: params.source_exclude,
						max_age: params.max_age,
						updated_since: sinceFrom(params.updated_within),
						verified: params.verified,
						advertiser_type: params.advertiser_type,
						compound: params.compound,
						q: params.q,
						livings_min: params.livings_min,
						days_on_market_min: params.days_on_market_min,
						days_on_market_max: params.days_on_market_max,
						sort: params.sort,
						cursor: params.cursor,
						limit: params.limit,
					}),
					params,
				);
			},
		);

		this.server.registerTool(
			"get_listings_by_ids",
			{
				description:
					"Fetch full details for multiple listings by their IDs in one call (max 100). Use when comparing specific listings or looking up several listings the user referenced.",
				inputSchema: {
					ids: z.string().describe("Comma-separated listing IDs (e.g. '12345,67890')"),
				},
				annotations: READ_ONLY,
			},
			async (params) => {
				return result(
					"get_listings_by_ids",
					await api("/listings/batch", { ids: params.ids }),
					params,
				);
			},
		);

		this.server.registerTool(
			"get_listings_count",
			{
				description:
					"Count listings matching filters without fetching listing data. Returns just { total: number }. Use when the user asks 'how many listings...?' or you need a count for context without the overhead of full results.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					listing_category: z
						.enum(["residential", "commercial"])
						.optional()
						.default("residential")
						.describe(
							"Use 'commercial' for office, shop, warehouse. Default: 'residential'.",
						),
					property_type: z.enum(PROPERTY_TYPE_ENUM).optional(),
					neighborhood_id: z
						.string()
						.optional()
						.describe(
							"Neighborhood id(s), comma-separated. Call list_neighborhoods first to get ids.",
						),
					beds: z.number().optional().describe("Number of bedrooms"),
					price_min: z.number().optional().describe("Minimum price in SAR"),
					price_max: z.number().optional().describe("Maximum price in SAR"),
				},
				annotations: READ_ONLY,
			},
			async (params) => {
				return result(
					"get_listings_count",
					await api("/listings/count", {
						city: params.city,
						listing_type: params.listing_type,
						listing_category: params.listing_category,
						property_type: concrete(params.property_type),
						neighborhood_id: params.neighborhood_id,
						beds: params.beds,
						price_min: params.price_min,
						price_max: params.price_max,
					}),
					params,
				);
			},
		);

		this.server.registerTool(
			"get_listing",
			{
				description:
					"Get full details for a specific listing by ID. Returns all fields: price, bedrooms, bathrooms, area_sqm, neighborhood (Arabic and English), property_type, images, furnished status, amenities, building age, floor, source, coordinates, and more. Call this before get_listing_market_stats or get_comparable_listings to get the listing's details first.",
				inputSchema: { id: z.number().describe("Listing ID") },
				annotations: READ_ONLY,
			},
			async ({ id }) => result("get_listing", await api(`/listings/${id}`)),
		);

		this.server.registerTool(
			"get_comparable_listings",
			{
				description:
					"Find similar listings near a specific listing for direct price comparison. Returns up to N nearby listings (within ~5km) matching the same property type and similar bedroom count (+/-1), plus the median price across all comparables. Each comparable includes: id, price, bedrooms, area_sqm, neighborhood, source, and URL. Use get_listing first to get listing details, then this tool to see nearby alternatives at different prices.",
				inputSchema: {
					id: z.number().describe("Listing ID to find comparables for"),
					limit: z.number().min(1).max(50).optional().default(20).describe("Max results"),
				},
				annotations: READ_ONLY,
			},
			async (params) => {
				return result(
					"get_comparable_listings",
					await api(`/listings/${params.id}/comparables`, { limit: params.limit }),
					params,
				);
			},
		);

		this.server.registerTool(
			"get_price_history",
			{
				description:
					"Get price change history for a listing. Shows how the price evolved over time, total price change percentage, and days on market.",
				inputSchema: {
					id: z.number().describe("Listing ID"),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result("get_price_history", await api(`/listings/${params.id}/price-history`)),
		);

		this.server.registerTool(
			"get_best_value_listings",
			{
				description:
					"Find listings priced below their neighborhood median -- best deals. Returns listings sorted by discount percentage (biggest savings first), with each listing showing its price, neighborhood_median, and discount_pct. When filtering by neighborhood, call list_neighborhoods first to get neighborhood ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					listing_category: z
						.enum(["residential", "commercial"])
						.optional()
						.default("residential")
						.describe(
							"Use 'commercial' for office, shop, warehouse. Default: 'residential'.",
						),
					property_type: z
						.enum(["apartment", "villa", "floor", "duplex"])
						.optional()
						.describe("Deals are residential only."),
					neighborhood_id: z
						.string()
						.optional()
						.describe("Neighborhood name(s), comma-separated"),
					beds: z.number().optional().describe("Exact number of bedrooms"),
					min_discount_pct: z
						.number()
						.min(5)
						.max(90)
						.optional()
						.default(10)
						.describe(
							"Minimum discount percentage below neighborhood median (default 10%)",
						),
					limit: z.number().optional().default(30).describe("Max results (max 100)"),
				},
				annotations: READ_ONLY,
			},
			async (params) => {
				return result(
					"get_best_value_listings",
					await api("/market/deals", {
						city: params.city,
						listing_type: params.listing_type,
						// /market/deals is residential by definition; it has no
						// listing_category and needs a residential property type.
						property_type: concrete(params.property_type),
						neighborhood_id: params.neighborhood_id,
						beds: params.beds,
						min_discount_pct: params.min_discount_pct,
						limit: params.limit,
					}),
					params,
				);
			},
		);

		// --- Market Analytics ---

		this.server.registerTool(
			"get_price_distribution",
			{
				description:
					"Get price distribution histogram for a market segment. Returns 30 buckets with counts, median, mean, and cumulative percentiles (e.g. '72% of listings are under 50K'). Supports optional bedroom filter to get distribution for a specific bedroom count (e.g. median 1BR rent in Al Yasmin). When filtering by neighborhood, call list_neighborhoods first to get neighborhood ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					listing_category: z
						.enum(["residential", "commercial"])
						.optional()
						.default("residential")
						.describe(
							"Use 'commercial' for office, shop, warehouse. Default: 'residential'.",
						),
					property_type: z.enum(PROPERTY_TYPE_ENUM).optional(),
					neighborhood_id: z
						.string()
						.optional()
						.describe("Neighborhood name(s), comma-separated"),
					beds: z
						.number()
						.int()
						.min(1)
						.max(5)
						.optional()
						.describe("Filter by bedroom count. 1-4 = exact match, 5 = 5+ bedrooms."),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_price_distribution",
					await api("/market/price-distribution", {
						city: params.city,
						listing_type: params.listing_type,
						listing_category: params.listing_category,
						property_type: concrete(params.property_type),
						neighborhood_id: params.neighborhood_id,
						beds: params.beds,
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_area_distribution",
			{
				description:
					"Get area (sqm) distribution histogram. Returns 30 buckets with counts, plus median and mean area. When filtering by neighborhood, call list_neighborhoods first to get neighborhood ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					listing_category: z
						.enum(["residential", "commercial"])
						.optional()
						.default("residential")
						.describe(
							"Use 'commercial' for office, shop, warehouse. Default: 'residential'.",
						),
					property_type: z.enum(PROPERTY_TYPE_ENUM).optional(),
					neighborhood_id: z
						.string()
						.optional()
						.describe("Neighborhood name(s), comma-separated"),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_area_distribution",
					await api("/market/area-distribution", {
						city: params.city,
						listing_type: params.listing_type,
						listing_category: params.listing_category,
						property_type: concrete(params.property_type),
						neighborhood_id: params.neighborhood_id,
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_listing_market_stats",
			{
				description:
					"Evaluate whether a listing's price is fair. Returns the listing's price percentile (e.g. 'cheaper than 72% of similar listings'), price range (P5-P95), area percentile, price-per-sqm vs median, neighborhood-level comparison (listing vs neighborhood median with diff%), and a bedroom price chart. Use this FIRST when a user asks 'is this a good deal?' or 'is this overpriced?'. For seeing actual comparable listings side by side, use get_comparable_listings instead.",
				inputSchema: { id: z.number().describe("Listing ID") },
				annotations: READ_ONLY,
			},
			async ({ id }) =>
				result("get_listing_market_stats", await api(`/listings/${id}/market-position`)),
		);

		this.server.registerTool(
			"compare_neighborhoods",
			{
				description:
					"Compare 2-5 neighborhoods side by side. Returns median price, area, price/sqm, price range (P25-P75), amenity percentages, property mix, bedroom breakdown, gross rental yield, and rent-to-income ratio (for rent listings). IMPORTANT: Call list_neighborhoods first to get exact English names.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					neighborhood_id: z
						.string()
						.describe(
							"2-5 neighborhood English names, comma-separated. Use list_neighborhoods to get valid names.",
						),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					property_type: z.enum(PROPERTY_TYPE_ENUM).optional(),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"compare_neighborhoods",
					await api("/market/neighborhoods/compare", {
						city: params.city,
						neighborhood_id: params.neighborhood_id,
						listing_type: params.listing_type,
						property_type: params.property_type,
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_rental_yield",
			{
				description:
					"Calculate gross rental yield for a neighborhood or city by comparing median sale price to median annual rent. Returns the city-wide figure plus every neighborhood with enough listings on both sides. Gross yield ignores vacancy, service charges and transaction costs, and compares asking prices, so use it to rank areas rather than to value a property.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					neighborhood_id: z
						.string()
						.optional()
						.describe(
							"Neighborhood id(s), comma-separated. Call list_neighborhoods first to get ids.",
						),
					property_type: z
						.enum(["apartment", "villa", "floor", "duplex", "land", "building"])
						.default("apartment")
						.describe(
							"Required, so rents and prices of different kinds of property are never mixed.",
						),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_rental_yield",
					await api("/market/rental-yield", {
						city: params.city,
						neighborhood_id: params.neighborhood_id,
						property_type: concrete(params.property_type),
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_supply_stats",
			{
				description:
					"Get new listing volume trends: how many listings appeared this week vs last week, this month vs last month, with percentage changes and total active count. Use to assess whether supply is increasing or decreasing in a market. When filtering by neighborhood, call list_neighborhoods first to get neighborhood ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					neighborhood_id: z
						.string()
						.optional()
						.describe("Neighborhood name(s), comma-separated"),
					property_type: z.enum(PROPERTY_TYPE_ENUM).optional(),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_supply_stats",
					await api("/market/supply", {
						city: params.city,
						listing_type: params.listing_type,
						neighborhood_id: params.neighborhood_id,
						property_type: concrete(params.property_type),
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_vacancy_indicator",
			{
				description:
					"Count stale listings (on market 30/60/90+ days) as an oversupply signal. Returns stale counts, percentages, and a freshness score (healthy/moderate/oversaturated). Use to assess whether a neighborhood has too much unsold/unrented inventory. When filtering by neighborhood, call list_neighborhoods first to get neighborhood ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					neighborhood_id: z
						.string()
						.optional()
						.describe("Neighborhood name(s), comma-separated"),
					property_type: z.enum(PROPERTY_TYPE_ENUM).optional(),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_vacancy_indicator",
					await api("/market/vacancy", {
						city: params.city,
						listing_type: params.listing_type,
						neighborhood_id: params.neighborhood_id,
						property_type: concrete(params.property_type),
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_neighborhood_rent_map",
			{
				description:
					"Get median price and listing count for every neighborhood in a city, sorted by median price descending. Works for both rent and sale listings (set listing_type). Use for city-wide price comparisons, finding the cheapest/most expensive neighborhoods, or ranking all neighborhoods by price.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					bedrooms: z
						.string()
						.optional()
						.describe("Filter by bedroom count, or 'all' for every bedroom count"),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_neighborhood_rent_map",
					await api("/market/neighborhoods", {
						city: params.city,
						listing_type: params.listing_type,
						beds: concrete(params.bedrooms),
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_market_summary",
			{
				description:
					"Get a high-level market overview for a city: total listings, median price, median area, median price/sqm, breakdown by property type, top 10 neighborhoods by listing count, source coverage, data freshness, and YoY median price change. Use as the starting point for broad market questions.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					property_type: z
						.enum(PROPERTY_TYPE_ENUM)
						.optional()
						.describe(
							"Filter to a specific property type, or omit for city-wide overview",
						),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_market_summary",
					await api("/market/summary", {
						city: params.city,
						listing_type: params.listing_type,
						property_type: concrete(params.property_type),
					}),
					params,
				),
		);

		this.server.registerTool(
			"get_neighborhood_trends",
			{
				description:
					"Get monthly price trends for 1-5 neighborhoods over time. Returns median price, P25/P75 range, and listing count per month. Shows price_change_pct between earliest and latest month. Use to answer questions about whether prices are rising or falling in a neighborhood. IMPORTANT: Call list_neighborhoods first to get exact English names.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh"),
					neighborhood_id: z
						.string()
						.describe(
							"1-5 neighborhood English names, comma-separated. Use list_neighborhoods to get valid names.",
						),
					listing_type: z.enum(["rent", "sale"]).optional().default("rent"),
					property_type: z.enum(PROPERTY_TYPE_ENUM).optional(),
					months: z
						.number()
						.min(2)
						.max(12)
						.optional()
						.default(6)
						.describe("How many months of history (max 12)"),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"get_neighborhood_trends",
					await api("/market/trends", {
						city: params.city,
						neighborhood_id: params.neighborhood_id,
						listing_type: params.listing_type,
						property_type: concrete(params.property_type),
						months: params.months,
					}),
					params,
				),
		);

		// --- Geography & Navigation ---

		this.server.registerTool(
			"list_neighborhoods",
			{
				description:
					"List all neighborhoods in a city. Returns name in Arabic and English, plus a price_tier (1=cheapest quartile to 4=most expensive). Use this to get exact neighborhood names before calling other tools that filter by neighborhood. Also useful when a user asks 'which neighborhoods are affordable?' -- check the price_tier.",
				inputSchema: { city: z.enum(CITY_ENUM).optional().default("riyadh") },
				annotations: READ_ONLY,
			},
			async ({ city }) =>
				result("list_neighborhoods", await api(`/cities/${city}/neighborhoods`), { city }),
		);

		this.server.registerTool(
			"list_city_directions",
			{
				description:
					"Get geographic regions of a city (north, south, east, west, center) with their neighborhoods. Use when a user asks about a broad area like 'north Riyadh' or 'eastern Jeddah' to find which neighborhoods are in that direction, then pass those neighborhoods to other tools.",
				inputSchema: { city: z.enum(CITY_ENUM).optional().default("riyadh") },
				annotations: READ_ONLY,
			},
			async ({ city }) =>
				result("list_city_directions", await api(`/cities/${city}/directions`), { city }),
		);

		// --- Projects (Off-Plan & Ready) ---

		this.server.registerTool(
			"search_projects",
			{
				description:
					"Search off-plan and ready real estate development projects in Saudi Arabia. Returns paginated projects with name, developer, city, neighborhood, starting price, price range, area range, unit count, bedroom range, images, and status. Use for questions about new developments, off-plan projects, or specific developers. IMPORTANT: When filtering by neighborhood, call list_neighborhoods first to get neighborhood ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).optional().default("riyadh").describe("City to search"),
					type: z
						.enum(["off_plan", "ready", "all"])
						.optional()
						.describe(
							"Project type: 'off_plan' for under-construction, 'ready' for completed, or 'all'",
						),
					category: z
						.enum(["residential", "commercial", "all"])
						.optional()
						.default("residential")
						.describe("Property category"),
					developer: z
						.string()
						.optional()
						.describe(
							"Developer name (exact match). Use list_developers to get valid names.",
						),
					neighborhood_id: z
						.string()
						.optional()
						.describe(
							"Neighborhood id(s), comma-separated. Call list_neighborhoods first to get ids.",
						),
					features: z
						.string()
						.optional()
						.describe(
							"Comma-separated project features to require (e.g. pool, gym, parking, mosque, playground)",
						),
					banks: z
						.string()
						.optional()
						.describe("Comma-separated supported bank names for mortgage financing"),
					price_min: z
						.number()
						.optional()
						.describe("Minimum project starting price in SAR"),
					price_max: z
						.number()
						.optional()
						.describe("Maximum project starting price in SAR"),
					q: z
						.string()
						.optional()
						.describe("Search project name or developer name (partial match)"),
					sort: z
						.enum(["updated_desc", "price_asc", "price_desc"])
						.optional()
						.default("updated_desc")
						.describe("Sort order"),
					cursor: z
						.string()
						.optional()
						.describe(
							"next_cursor from a previous response, to get the following page.",
						),
					limit: z.number().optional().default(30).describe("Results per page (max 100)"),
				},
				annotations: READ_ONLY,
			},
			async (params) => {
				return result(
					"search_projects",
					await api("/projects", {
						city: params.city,
						project_type: concrete(params.type),
						listing_category: concrete(params.category),
						developer: params.developer,
						neighborhood_id: params.neighborhood_id,
						features: params.features,
						banks: params.banks,
						price_min: params.price_min,
						price_max: params.price_max,
						q: params.q,
						sort: params.sort,
						cursor: params.cursor,
						limit: params.limit,
					}),
					params,
				);
			},
		);

		this.server.registerTool(
			"get_project",
			{
				description:
					"Get full details for a specific development project by ID. Returns all project fields (name, developer, city, neighborhood, status, type, starting price, price range, area range, features, supported banks, images, coordinates, polygon) plus a summary of its linked units — how many, and their price, area and bedroom ranges. For the units themselves call search_project_units with this project's developer or neighborhood.",
				inputSchema: { id: z.number().describe("Project ID") },
				annotations: READ_ONLY,
			},
			async ({ id }) => result("get_project", await api(`/projects/${id}`)),
		);

		this.server.registerTool(
			"list_developers",
			{
				description:
					"List real estate developers with active projects in a city. Returns each developer's name, how many projects they have and which cities they build in. Use it to get an exact developer name before filtering search_projects by developer. Results are paginated: pass next_cursor to see more.",
				inputSchema: {
					city: z
						.enum(CITY_ENUM)
						.optional()
						.default("riyadh")
						.describe("City to list developers for"),
					cursor: z
						.string()
						.optional()
						.describe(
							"next_cursor from a previous response, to get the following page.",
						),
					limit: z.number().optional().default(50).describe("Results per page (max 100)"),
				},
				annotations: READ_ONLY,
			},
			async (params) =>
				result(
					"list_developers",
					await api("/developers", {
						city: params.city,
						cursor: params.cursor,
						limit: params.limit,
					}),
					params,
				),
		);

		this.server.registerTool(
			"search_project_units",
			{
				description:
					"Search individual units within development projects. Returns paginated unit listings with price, bedrooms, bathrooms, area, floor, property type, project name, and neighborhood. Use when the user wants to find specific unit types across projects (e.g. '3BR units under 1.5M in off-plan projects'). IMPORTANT: When filtering by neighborhood, call list_neighborhoods first to get neighborhood ids.",
				inputSchema: {
					city: z.enum(CITY_ENUM).describe("City to search (required)"),
					unit_beds: z
						.number()
						.optional()
						.describe("Number of bedrooms (exact match for 1-4, minimum for 5+)"),
					unit_bathrooms: z
						.number()
						.optional()
						.describe("Number of bathrooms (exact match for 1-2, minimum for 3+)"),
					unit_price_min: z.number().optional().describe("Minimum unit price in SAR"),
					unit_price_max: z.number().optional().describe("Maximum unit price in SAR"),
					unit_area_min: z.number().optional().describe("Minimum unit area in sqm"),
					unit_area_max: z.number().optional().describe("Maximum unit area in sqm"),
					neighborhood_id: z
						.string()
						.optional()
						.describe(
							"Neighborhood id(s), comma-separated. Call list_neighborhoods first to get ids.",
						),
					type: z
						.enum(["off_plan", "ready", "all"])
						.optional()
						.describe("Project type filter"),
					developer: z
						.string()
						.optional()
						.describe(
							"Developer name (exact match). Use list_developers to get valid names.",
						),
					features: z
						.string()
						.optional()
						.describe("Comma-separated project features to require"),
					banks: z.string().optional().describe("Comma-separated supported bank names"),
					sort: z
						.enum(["newest", "price_asc", "price_desc", "area_desc", "bedrooms_desc"])
						.optional()
						.default("newest")
						.describe("Sort order"),
					cursor: z
						.string()
						.optional()
						.describe(
							"next_cursor from a previous response, to get the following page.",
						),
					limit: z.number().optional().default(30).describe("Results per page (max 100)"),
				},
				annotations: READ_ONLY,
			},
			async (params) => {
				return result(
					"search_project_units",
					await api("/project-units", {
						city: params.city,
						bedrooms: params.unit_beds,
						bathrooms: params.unit_bathrooms,
						// On this endpoint price and area are the unit's; the project's
						// own starting price is not a filter here.
						price_min: params.unit_price_min,
						price_max: params.unit_price_max,
						area_min: params.unit_area_min,
						area_max: params.unit_area_max,
						neighborhood_id: params.neighborhood_id,
						project_type: concrete(params.type),
						developer: params.developer,
						features: params.features,
						banks: params.banks,
						sort: params.sort,
						cursor: params.cursor,
						limit: params.limit,
					}),
					params,
				);
			},
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// RFC 9728. An MCP client reads this to discover where to sign in, and
		// only looks for it after a 401 naming it, so advertising it costs an
		// anonymous caller nothing.
		if (url.pathname === "/.well-known/oauth-protected-resource") {
			return Response.json(
				{
					resource: `${url.origin}/mcp`,
					authorization_servers: [AUTHORIZATION_SERVER],
					bearer_methods_supported: ["header"],
					resource_documentation: "https://platform.darak.app/docs",
				},
				{ headers: { "cache-control": "public, max-age=3600" } },
			);
		}

		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			// The agents SDK hands ctx.props to the Durable Object as this.props;
			// ExecutionContext types it read-only.
			const ip = request.headers.get("cf-connecting-ip") ?? "";
			(ctx as ExecutionContext & { props: CallerProps }).props = {
				ipHash: ip ? await hashIp(ip, env.MCP_IP_SALT || "darak-mcp") : "",
				userAgent: (request.headers.get("user-agent") ?? "").slice(0, 120),
				sessionId: request.headers.get("mcp-session-id") ?? "",
				accessToken: bearerFrom(request.headers.get("authorization")),
			};
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		if (url.pathname === "/") {
			return Response.redirect("https://darak.app/connect", 302);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
