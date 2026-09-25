import assert from "node:assert/strict";
import test from "node:test";
import {
	AUTHORIZATION_SERVER,
	MCP_READ_SCOPE,
	MCP_RESOURCE,
	bearerFrom,
	protectedResourceMetadata,
	resourceMetadataUrl,
} from "../src/oauth.ts";

test("protected-resource metadata matches the Darak OAuth 1.7 resource and issuer", () => {
	assert.equal(MCP_RESOURCE, "https://darak.app/mcp");
	assert.equal(AUTHORIZATION_SERVER, "https://darak.app/api/auth");
	assert.equal(MCP_READ_SCOPE, "darak.read");
	assert.deepEqual(protectedResourceMetadata(), {
		resource: "https://darak.app/mcp",
		authorization_servers: ["https://darak.app/api/auth"],
		bearer_methods_supported: ["header"],
		scopes_supported: ["darak.read"],
		resource_documentation: "https://platform.darak.app/docs",
	});
});

test("resource challenges point back to the responding origin's metadata", () => {
	assert.equal(
		resourceMetadataUrl("https://darak.app"),
		"https://darak.app/.well-known/oauth-protected-resource",
	);
	assert.equal(
		resourceMetadataUrl("http://localhost:8787"),
		"http://localhost:8787/.well-known/oauth-protected-resource",
	);
});

test("only a single Bearer token may reach the metered API", () => {
	assert.equal(bearerFrom("Bearer jwt.token"), "jwt.token");
	assert.equal(bearerFrom("  bEaReR   jwt.token  "), "jwt.token");
	for (const header of [
		null,
		"",
		"DPoP jwt.token",
		"Basic credential",
		"Bearer",
		"Bearer one two",
	]) {
		assert.equal(bearerFrom(header), "", String(header));
	}
});
