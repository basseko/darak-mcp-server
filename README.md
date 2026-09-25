# Darak MCP Server

Remote MCP server for Saudi real estate data. Gives AI assistants access to 65,000+ rental and sale property listings across 5 Saudi cities, with market analytics, neighborhood comparisons, and price trends.

**Server URL:** `https://platform.darak.app/mcp`

## Tools (23, all read-only)

### Search & Listings

| Tool                      | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `search_listings`         | Search rental and sale listings with filters    |
| `get_listings_by_ids`     | Fetch several listings by ID                    |
| `get_listings_count`      | Count listings matching search filters          |
| `get_listing`             | Full details for one listing                    |
| `get_comparable_listings` | Similar nearby listings for price comparison    |
| `get_price_history`       | Price changes over time for a listing           |
| `get_best_value_listings` | Listings priced below their neighborhood median |

### Market Analytics

| Tool                        | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `get_price_distribution`    | Price histogram and percentiles                 |
| `get_area_distribution`     | Area (sqm) distribution                         |
| `get_listing_market_stats`  | Listing price and area context                  |
| `compare_neighborhoods`     | Side-by-side neighborhood comparison            |
| `get_rental_yield`          | Gross yield from rental and sale medians        |
| `get_supply_stats`          | Listing supply over time                        |
| `get_vacancy_indicator`     | Stale listing counts                            |
| `get_neighborhood_rent_map` | Neighborhood rent values for map visualizations |
| `get_market_summary`        | City-level market overview                      |
| `get_neighborhood_trends`   | Monthly neighborhood price trends               |

### Geography

| Tool                   | Description                            |
| ---------------------- | -------------------------------------- |
| `list_neighborhoods`   | Neighborhood IDs and names by city     |
| `list_city_directions` | City districts and their neighborhoods |

### Off-plan Projects

| Tool                   | Description                               |
| ---------------------- | ----------------------------------------- |
| `search_projects`      | Find developments by location and filters |
| `get_project`          | Project details                           |
| `list_developers`      | Developers with off-plan projects         |
| `search_project_units` | Find available units in projects          |

## Cities

Riyadh, Jeddah, Eastern Province, Makkah, Madinah.

## Connect

### Claude Desktop / Claude Code

```json
{
	"mcpServers": {
		"darak": {
			"command": "npx",
			"args": ["mcp-remote", "https://platform.darak.app/mcp"]
		}
	}
}
```

### Claude Code (CLI)

```bash
claude mcp add --transport http darak https://platform.darak.app/mcp
```

### Any MCP client (Streamable HTTP)

Connect directly to `https://platform.darak.app/mcp` using the Streamable HTTP transport.

## Connected accounts and OAuth

Anonymous access uses a shared service key and a per-caller budget. When that
budget is exhausted, the server returns a Bearer challenge pointing to
`https://platform.darak.app/.well-known/oauth-protected-resource`. Its metadata
names `https://platform.darak.app/mcp` as the resource, `darak.read` as the scope, and
`https://darak.app/api/auth` as the authorization-server issuer. Production
`BETTER_AUTH_URL` uses `darak.app`; even metadata fetched from
`platform.darak.app` advertises the `darak.app/api/auth` issuer. Clients discover
the authorize/token/registration endpoints from that issuer;
the Worker is a resource server and does not mint credentials.

A connected caller's Bearer token is forwarded unchanged to the versioned Darak
API, which validates the issuer, audience, expiry, and scope and meters the
caller's organization. DPoP and malformed authorization headers are rejected,
not silently treated as anonymous; DPoP-bound tokens sent as Bearer are rejected
by the API. The Worker cannot support DPoP-bound access tokens without verifying
proofs itself or coordinating a proof-preserving API call.

**Hard cutover:** The old `https://darak.app/mcp` route will be retired, not
redirected. Update every MCP client configuration to `https://platform.darak.app/mcp`
and reconnect: old-resource tokens and consent do not transfer. Keep the OAuth
issuer at `https://darak.app/api/auth`. Deploy the app's guarded resource migration
and new audience verification before switching this Cloudflare Worker route.
After deployment, test discovery, S256 PKCE, consent, token refresh, and a
connected MCP call. Clients may cache old metadata for up to an hour.

## Development

```bash
npm install
npm run dev         # Local dev server at http://localhost:8787
npm run type-check
npm test            # Node 24
npm run deploy      # Deploy only after the coordinated rollout
```

## Architecture

- Runs on Cloudflare Workers with Durable Objects
- Calls the public, versioned, metered Darak API at `https://api.darak.app/v1`
- All tools are read-only (annotated with `readOnlyHint: true`)
- Anonymous use is available; connected accounts can use OAuth Bearer tokens

## Privacy Policy

See [https://darak.app/privacy](https://darak.app/privacy) for the full privacy policy.

**Data handling summary:**

- **Authentication is optional.** A connected caller's access token is forwarded to the Darak API for authorization and metering; this Worker code does not mint or persist it. Anonymous usage budgets are keyed by a salted hash of the caller IP.
- **No conversation data stored.** Queries are proxied to the Darak API and responses are returned directly. The server does not log, store, or inspect query contents.
- **Anonymous usage analytics.** Tool call events (tool name, city, listing type, success/failure) are sent to PostHog for aggregate usage monitoring. No personally identifiable information is included.
- **No third-party data sharing.** Data is not sold, shared, or transferred to third parties beyond the PostHog analytics described above.
- **Data source.** All property data is aggregated from publicly available Saudi real estate platforms.

## Support

- Website: [darak.app](https://darak.app)
- Issues: [github.com/basseko/darak-mcp-server/issues](https://github.com/basseko/darak-mcp-server/issues)
- Twitter/X: [@getdarak](https://x.com/getdarak)
