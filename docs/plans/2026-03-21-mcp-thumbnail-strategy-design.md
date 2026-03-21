# MCP Thumbnail Strategy Design

## Problem

Claude.ai's widget system (show_widget) blocks external image URLs via CSP. Only `data:` URIs are allowed in `<img src>`. The MCP server needs to return base64-encoded thumbnails directly in the listing JSON so Claude can embed them in widget HTML.

MCP `output_image` content blocks render visually for Claude but Claude cannot extract the raw base64 string to use in code. The data must be in the JSON text as a readable field.

## Constraints

- **Cloudflare Workers**: no sharp/image processing. Images served as-is (~30-50KB webp, ~40-67KB base64).
- **50 subrequests per invocation**: 1 for the API call, max 49 for image fetches.
- **Image hosts block Vercel IPs**: server-side proxy via darak.app does not work. Cloudflare Workers can reach image sources directly.
- **Artifacts CSP**: `img-src blob: data: https://www.claudeusercontent.com` -- data URIs are allowed.

## Design

### Opt-in parameter

All listing-returning tools get an `include_thumbnails` boolean parameter (default `false`):

- `search_listings`
- `get_listing`
- `get_comparable_listings`
- `get_best_value_listings`

Analytics and geography tools are unchanged.

### Behavior when `include_thumbnails=true`

1. Default `page_size`/`limit` drops to 12 (a natural grid size for widgets). User can override up to 49.
2. First image URL from each listing is fetched in parallel (5s timeout, failures skipped silently).
3. Base64-encoded data URI is added as `thumbnail_b64` field on each listing object.
4. If `page_size > 49`, only the first 49 listings get thumbnails (subrequest ceiling).

### Response format

```json
{
  "listings": [
    {
      "id": 179,
      "price": 70000,
      "thumbnail_b64": "data:image/webp;base64,UklGR...",
      "images": ["https://images.aqar.fm/..."],
      ...
    }
  ]
}
```

Claude uses `<img src="${listing.thumbnail_b64}">` in widget code.

### Size budget

| Listings | Avg base64 size | Total added |
|----------|----------------|-------------|
| 1        | ~47KB          | ~47KB       |
| 12       | ~47KB          | ~560KB      |
| 30       | ~47KB          | ~1.4MB      |
| 49       | ~47KB          | ~2.3MB      |

Default 12 keeps responses under 600KB of image data.

### What stays the same

- `images` array remains in listings for reference/linking.
- When `include_thumbnails` is `false` (default), no image fetching occurs and no `thumbnail_b64` field is added. Response is identical to current behavior.
- No separate `output_image` content blocks. All image data is in the JSON text.
