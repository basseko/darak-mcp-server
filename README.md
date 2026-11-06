# Kite MCP Server

Remote MCP server for Saudi real estate data from [Kite](https://kite.sa) (formerly Darak). It lets an AI assistant search live rental and sale listings, check whether a price is fair, compare neighborhoods and look up development projects.

**Server URL:** `https://mcp.kite.sa/mcp` (Streamable HTTP, OAuth sign-in)

Full documentation: [platform.kite.sa/docs/mcp](https://platform.kite.sa/docs/mcp)

> This repository holds the earlier source of the server. The hosted server at `mcp.kite.sa` is now maintained in Kite's main codebase; this repository is kept for reference and for directory listings. The old `platform.darak.app/mcp` and `darak.app/mcp` addresses are retired: remove the server from your client and add it again with the new URL.

## Connect

### Claude (claude.ai, Desktop, mobile)

Open **Customize → Connectors**, find Kite in the directory and select **Connect**.

### Claude Code

```bash
claude mcp add --transport http kite https://mcp.kite.sa/mcp
```

Then run `/mcp` inside Claude Code and choose Kite to sign in.

### Any MCP client

Add a remote server with the URL `https://mcp.kite.sa/mcp`. Any client that supports remote MCP servers over Streamable HTTP with OAuth sign-in can connect. If an app only runs local servers, bridge with `mcp-remote` (requires Node.js):

```json
{
  "mcpServers": {
    "kite": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.kite.sa/mcp"]
    }
  }
}
```

## Signing in

The first time the assistant uses Kite, it opens Kite sign-in in your browser. Enter your email, enter the 6-digit code Kite sends, pick a workspace (a free Sandbox workspace is created if you're new) and approve read-only access. Calls count against that workspace's plan. Never paste an API key into an MCP configuration; sign-in is the only way the server accepts a connection.

## Tools (18, all read-only)

| Tool                        | What it answers                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `search_listings`           | Active rental or sale listings matching neighborhood, price, rooms, area, amenities and more |
| `get_listings_count`        | How many listings match, without returning them                                              |
| `get_listings`              | Full records for up to 100 listings by id                                                    |
| `get_comparable_listings`   | Similar listings nearby, with a price summary                                                |
| `get_price_history`         | A listing's recorded price changes                                                           |
| `check_listing_price`       | Whether one listing's price is high or low against its city and neighborhood                 |
| `get_best_value_listings`   | Listings priced furthest below comparable ones                                               |
| `get_market_stats`          | Median prices, distributions and supply for one market segment                               |
| `get_neighborhood_rent_map` | Median price for every neighborhood in a city                                                |
| `compare_neighborhoods`     | Two to five neighborhoods side by side                                                       |
| `get_neighborhood_trends`   | Monthly asking-price trend over the last 2 to 12 months                                      |
| `get_rental_yield`          | Estimated gross rental yield by city and neighborhood                                        |
| `get_reference_data`        | Neighborhood names and ids, city areas such as "north Riyadh", and other lookups             |
| `search_projects`           | Off-plan and ready development projects                                                      |
| `get_project`               | One project's full record                                                                    |
| `get_project_units`         | The units inside one project                                                                 |
| `search_project_units`      | Units across projects, by project and unit filters                                           |
| `list_developers`           | Developers with active projects                                                              |

## What the data is

- Every price is the asking price of an active listing, not a completed sale, a signed lease or a registered deal.
- Prices are in SAR, and rent is always per year, even when the ad was posted monthly.
- Medians and trends describe asking prices and shift when the mix of listings changes. They are not forecasts or appraisals.

## For client developers

On the first request the server answers `401` with a Bearer challenge. The [protected-resource metadata](https://mcp.kite.sa/.well-known/oauth-protected-resource) names `https://mcp.kite.sa/mcp` as the resource, `darak.read` as the scope and `https://darak.app/api/auth` as the authorization-server issuer. The issuer and scope names are legacy and stable. Clients must use OAuth 2.1 with S256 PKCE.

## Also from Kite

- REST API: `https://api.kite.sa/v1` ([OpenAPI](https://api.kite.sa/v1/openapi.json), [docs](https://platform.kite.sa/docs))
- SDKs: [`@kite-sa/sdk`](https://www.npmjs.com/package/@kite-sa/sdk) (npm) and [`kite-sa`](https://pypi.org/project/kite-sa/) (PyPI)

## Privacy

See [kite.sa/en/privacy](https://kite.sa/en/privacy). The server proxies tool calls to the Kite API; calls are logged in the workspace's request log under that workspace's retention setting.
