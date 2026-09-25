// Keep these values aligned with darak's src/lib/mcp-oauth.ts. OAuth tokens
// issued for the Worker must name this exact resource and issuer.
export const MCP_RESOURCE = "https://darak.app/mcp";
export const MCP_READ_SCOPE = "darak.read";
export const AUTHORIZATION_SERVER = "https://platform.darak.app/api/auth";

export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** RFC 9728 metadata served by the Worker at the MCP resource's origin. */
export function protectedResourceMetadata() {
	return {
		resource: MCP_RESOURCE,
		authorization_servers: [AUTHORIZATION_SERVER],
		bearer_methods_supported: ["header"],
		scopes_supported: [MCP_READ_SCOPE],
		resource_documentation: "https://platform.darak.app/docs",
	};
}

export function resourceMetadataUrl(origin: string): string {
	return new URL(RESOURCE_METADATA_PATH, origin).toString();
}

/** Only a single Bearer credential can be forwarded to the v1 API. */
export function bearerFrom(header: string | null): string {
	const match = /^Bearer[ \t]+([^\s]+)$/i.exec(header?.trim() ?? "");
	return match?.[1] ?? "";
}
