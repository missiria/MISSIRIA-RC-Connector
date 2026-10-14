import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './server.js';

/** Write and send tools land in the P4 ticket (EKSN-0154). */
export function registerWriteTools(_server: McpServer, _ctx: ToolContext): void {}
