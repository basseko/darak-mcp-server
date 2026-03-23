# Darak MCP Server

Remote MCP server for Saudi real estate data. Gives AI assistants access to 65,000+ rental and sale property listings across 5 Saudi cities, with market analytics, neighborhood comparisons, and price trends.

**Server URL:** `https://darak.app/mcp`

## Tools (16, all read-only)

### Search & Listings
| Tool | Description |
|------|-------------|
| `search_listings` | Search with 20+ filters (city, price, beds, neighborhood, amenities, etc.) |
| `get_listing` | Full details for a specific listing |
| `get_comparable_listings` | Similar nearby listings for price comparison |
| `get_price_history` | Price changes over time for a listing |
| `get_best_value_listings` | Listings priced below neighborhood median |

### Market Analytics
| Tool | Description |
|------|-------------|
| `get_price_distribution` | Price histogram with median and mean |
| `get_area_distribution` | Area (sqm) histogram with median and mean |
| `get_listing_market_stats` | Price/area percentiles and neighborhood context for a listing |
| `compare_neighborhoods` | Side-by-side comparison of 2-5 neighborhoods |
| `get_market_summary` | City-level overview: totals, medians, top neighborhoods |
| `get_neighborhood_trends` | Monthly price trends with P25/P75 range |

### Geography
| Tool | Description |
|------|-------------|
| `list_neighborhoods` | All neighborhoods in a city (Arabic + English names) |
| `list_city_directions` | City districts with their neighborhoods |
| `get_neighborhood_pois` | Points of interest near a neighborhood |
| `get_map_listings` | Listings within geographic bounds |
| `get_map_pois` | Points of interest within geographic bounds |

## Cities

Riyadh, Jeddah, Eastern Province, Makkah, Madinah.

## Connect

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "darak": {
      "command": "npx",
      "args": ["mcp-remote", "https://darak.app/mcp"]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add --transport http darak https://darak.app/mcp
```

### Any MCP client (Streamable HTTP)

Connect directly to `https://darak.app/mcp` using the Streamable HTTP transport.

## Development

```bash
npm install
npm run dev       # Local dev server at http://localhost:8787
npm run deploy    # Deploy to Cloudflare Workers
```

## Architecture

- Runs on Cloudflare Workers with Durable Objects
- Calls the public Darak API at `https://darak.app/api/*`
- All tools are read-only (annotated with `readOnlyHint: true`)
- No authentication required (public data)

## Privacy Policy

See [https://darak.app/privacy](https://darak.app/privacy) for the full privacy policy.

**Data handling summary:**

- **No user data collected.** The server does not require authentication and does not store any user information.
- **No conversation data stored.** Queries are proxied to the Darak API and responses are returned directly. The server does not log, store, or inspect query contents.
- **Anonymous usage analytics.** Tool call events (tool name, city, listing type, success/failure) are sent to PostHog for aggregate usage monitoring. No personally identifiable information is included.
- **No third-party data sharing.** Data is not sold, shared, or transferred to third parties beyond the PostHog analytics described above.
- **Data source.** All property data is aggregated from publicly available Saudi real estate platforms.

## Support

- Website: [darak.app](https://darak.app)
- Issues: [github.com/basseko/darak-mcp-server/issues](https://github.com/basseko/darak-mcp-server/issues)
- Twitter/X: [@getdarak](https://x.com/getdarak)
